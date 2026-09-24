import { act, render, screen } from "@testing-library/react";
import * as React from "react";
import { Provider } from "react-redux";
import { createStore, type Store } from "redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../../../types/IExtensionContext";
import type { IMod, IModRule } from "../../../mod_management/types/IMod";
import { findModByRef } from "../../../mod_management/util/findModByRef";
import type InstallDriver from "../../util/InstallDriver";
import InstallFinishedDialog from "./InstallFinishedDialog";

vi.mock("../../../mod_management/util/findModByRef", async (importOriginal) => {
  const actual = await importOriginal<{ findModByRef: typeof findModByRef }>();
  return { ...actual, findModByRef: vi.fn(actual.findModByRef) };
});

// The real Modal keeps rendering its children while it fades out after `show` turns false, so the
// stub always renders them and only records `show`.
vi.mock("../../../../controls/Modal", () => {
  const passThrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Modal = ({ show, children }: { show: boolean; children?: React.ReactNode }) => (
    <div data-show={show} data-testid="install-finished-dialog">
      {children}
    </div>
  );
  Modal.Header = passThrough;
  Modal.Title = passThrough;
  Modal.Body = passThrough;
  Modal.Footer = passThrough;
  return { default: Modal };
});

// Render interpolation values too, so markup compared between renders includes the optional count.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<object>();
  const t = (key: string, options?: object) =>
    options === undefined ? key : `${key} ${JSON.stringify(options)}`;
  return { ...actual, useTranslation: () => ({ t }) };
});

vi.mock("../CollectionTile", () => ({ default: () => null }));

vi.mock("../../../gamemode_management/util/getGame", () => ({
  getGame: () => ({ name: "Test Game" }),
}));

const noFailures: unknown[] = [];
vi.mock("../../../../util/collectionInstallSessionSelectors", () => ({
  getFailedOptionalMods: () => noFailures,
  getFailedRequiredMods: () => noFailures,
  isActiveSessionStalled: () => false,
}));

const GAME_ID = "testgame";
const OPTIONAL_COUNT = 5;
const INSTALLED_OPTIONALS = 2;

const md5 = (i: number) => `md5-${i}`;

function makeMod(i: number): IMod {
  return {
    id: `mod-${i}`,
    state: "installed",
    type: "",
    installationPath: `mod-${i}`,
    attributes: { fileMD5: md5(i) },
  };
}

// Optional member i is installed when mod-i exists; members 0 and 1 are there from the start.
function optionalRule(i: number): IModRule {
  return { type: "recommends", reference: { fileMD5: md5(i) } };
}

const collectionRules: IModRule[] = [
  ...Array.from({ length: OPTIONAL_COUNT }, (_, i) => optionalRule(i)),
  { type: "requires", reference: { fileMD5: md5(100) } },
];

interface IModsState {
  persistent: {
    mods: { [gameId: string]: { [modId: string]: IMod } };
    nexus: { userInfo: { userId: number } };
  };
}

// The user is signed in but didn't curate the collection: the curator's variant adds clone prompts.
function modsReducer(
  state: IModsState = {
    persistent: { mods: { [GAME_ID]: {} }, nexus: { userInfo: { userId: 1 } } },
  },
  action: { type: string; payload?: IMod },
): IModsState {
  if (action.type !== "ADD_TEST_MOD" || action.payload === undefined) {
    return state;
  }
  const mods = { ...state.persistent.mods[GAME_ID], [action.payload.id]: action.payload };
  return { persistent: { ...state.persistent, mods: { [GAME_ID]: mods } } };
}

interface IFakeDriver {
  collection: IMod | undefined;
  step: string;
  profile: { id: string; gameId: string } | undefined;
  postprocessing: boolean;
  collectionInfo: undefined;
  onUpdate: (cb: () => void) => () => void;
  continue: () => Promise<void>;
  installRecommended: () => void;
}

let store: Store<IModsState>;
let driver: IFakeDriver;
let updateHandlers: Array<() => void>;

const lookups = () => vi.mocked(findModByRef).mock.calls.length;

const addMod = (i: number) => {
  act(() => {
    store.dispatch({ type: "ADD_TEST_MOD", payload: makeMod(i) });
  });
};

const triggerUpdate = () => updateHandlers.forEach((cb) => cb());

const setStep = (step: string) => {
  act(() => {
    driver.step = step;
    triggerUpdate();
  });
};

const renderDialog = () =>
  render(
    <Provider store={store}>
      <InstallFinishedDialog
        api={{ NAMESPACE: "test", events: { emit: vi.fn() }, store } as unknown as IExtensionApi}
        driver={driver as unknown as InstallDriver}
        editCollection={vi.fn()}
        onClone={vi.fn()}
      />
    </Provider>,
  );

// The footer offers "No Thanks" / "View optional mods" / "Install optional mods" while optional
// members are missing, and a single "Done" otherwise.
const footerButtons = () => screen.getAllByRole("button").length;

const dialog = () => screen.getByTestId("install-finished-dialog");
const dialogShown = () => dialog().dataset.show === "true";

// Footer order while optionals are offered: No Thanks, View optional mods, Install optional mods.
const NO_THANKS = 0;
const VIEW_OPTIONALS = 1;
const INSTALL_OPTIONALS = 2;

const clickFooterButton = async (index: number) => {
  await act(async () => {
    screen.getAllByRole("button")[index].click();
  });
};

beforeEach(() => {
  vi.mocked(findModByRef).mockClear();
  store = createStore(modsReducer);
  for (let i = 0; i < INSTALLED_OPTIONALS; i++) {
    store.dispatch({ type: "ADD_TEST_MOD", payload: makeMod(i) });
  }
  updateHandlers = [];
  driver = {
    collection: { ...makeMod(999), type: "collection", rules: collectionRules },
    step: "installing",
    profile: { id: "profile", gameId: GAME_ID },
    postprocessing: false,
    collectionInfo: undefined,
    onUpdate: (cb) => {
      updateHandlers.push(cb);
      return () => {
        updateHandlers = updateHandlers.filter((iter) => iter !== cb);
      };
    },
    // As InstallDriver: continuing from review closes it, which clears the collection...
    continue: vi.fn(() => {
      if (driver.step === "review") {
        driver.collection = undefined;
      }
      triggerUpdate();
      return Promise.resolve();
    }),
    // ...while installing the optionals leaves review with the collection still set.
    installRecommended: vi.fn(() => {
      driver.step = "installing";
      triggerUpdate();
    }),
  };
});

describe("InstallFinishedDialog optional members", () => {
  it("does not look up optional members while the install is still running", () => {
    renderDialog();
    for (let i = 0; i < 20; i++) {
      addMod(200 + i);
    }

    expect(dialogShown()).toBe(false);
    expect(lookups()).toBe(0);
  });

  it("looks each optional member up once when the review step opens", () => {
    renderDialog();
    for (let i = 0; i < 20; i++) {
      addMod(200 + i);
    }
    setStep("review");

    expect(dialogShown()).toBe(true);
    expect(lookups()).toBe(OPTIONAL_COUNT);
    expect(footerButtons()).toBe(3);
  });

  it("updates the offer when the missing optional members get installed during review", () => {
    driver.step = "review";
    renderDialog();
    expect(footerButtons()).toBe(3);

    for (let i = INSTALLED_OPTIONALS; i < OPTIONAL_COUNT; i++) {
      addMod(i);
    }

    expect(footerButtons()).toBe(1);
  });

  it("stops looking optional members up when the review step is left", () => {
    driver.step = "review";
    renderDialog();
    setStep("installing");
    vi.mocked(findModByRef).mockClear();

    for (let i = 0; i < 20; i++) {
      addMod(200 + i);
    }

    expect(dialogShown()).toBe(false);
    expect(lookups()).toBe(0);
  });

  it("keeps showing the offer while the dialog hides for Install optional mods", async () => {
    driver.step = "review";
    renderDialog();
    const initialOffer = dialog().innerHTML;
    addMod(INSTALLED_OPTIONALS);
    const reviewed = dialog().innerHTML;
    expect(reviewed).not.toBe(initialOffer);
    vi.mocked(findModByRef).mockClear();

    await clickFooterButton(INSTALL_OPTIONALS);

    expect(driver.installRecommended).toHaveBeenCalledTimes(1);
    expect(dialogShown()).toBe(false);
    expect(dialog().innerHTML).toBe(reviewed);
    expect(footerButtons()).toBe(3);

    for (let i = 0; i < 20; i++) {
      addMod(200 + i);
    }

    expect(dialog().innerHTML).toBe(reviewed);
    expect(lookups()).toBe(0);
  });

  it("offers only what is still missing when review opens again after the optionals", async () => {
    driver.step = "review";
    renderDialog();
    await clickFooterButton(INSTALL_OPTIONALS);
    for (let i = INSTALLED_OPTIONALS; i < OPTIONAL_COUNT; i++) {
      addMod(i);
    }
    vi.mocked(findModByRef).mockClear();

    setStep("review");

    expect(dialogShown()).toBe(true);
    expect(lookups()).toBe(OPTIONAL_COUNT);
    expect(footerButtons()).toBe(1);
  });

  it("does not carry one collection's reviewed offer over to another", async () => {
    driver.step = "review";
    renderDialog();
    await clickFooterButton(INSTALL_OPTIONALS);
    vi.mocked(findModByRef).mockClear();

    driver.collection = { ...makeMod(998), type: "collection", rules: collectionRules };
    driver.step = "query";
    addMod(200);

    expect(footerButtons()).toBe(1);
    expect(lookups()).toBe(0);
  });

  it.each([
    ["No Thanks", NO_THANKS],
    ["View optional mods", VIEW_OPTIONALS],
  ])("drops the offer when %s closes the review and clears the collection", async (_, button) => {
    driver.step = "review";
    renderDialog();
    vi.mocked(findModByRef).mockClear();

    await clickFooterButton(button);

    expect(driver.continue).toHaveBeenCalledTimes(1);
    expect(dialogShown()).toBe(false);
    expect(footerButtons()).toBe(1);
    expect(lookups()).toBe(0);
  });

  it("does not look up optional members when no collection is being installed", () => {
    driver.collection = undefined;
    driver.step = "review";
    renderDialog();
    addMod(200);

    expect(dialogShown()).toBe(false);
    expect(lookups()).toBe(0);
  });
});
