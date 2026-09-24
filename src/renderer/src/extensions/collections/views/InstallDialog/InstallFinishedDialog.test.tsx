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

vi.mock("../../../../controls/Modal", () => {
  const passThrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Modal = ({ show, children }: { show: boolean; children?: React.ReactNode }) =>
    show ? <div data-testid="install-finished-dialog">{children}</div> : null;
  Modal.Header = passThrough;
  Modal.Title = passThrough;
  Modal.Body = passThrough;
  Modal.Footer = passThrough;
  return { default: Modal };
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

const setStep = (step: string) => {
  act(() => {
    driver.step = step;
    updateHandlers.forEach((cb) => cb());
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
    continue: vi.fn(() => Promise.resolve()),
    installRecommended: vi.fn(),
  };
});

describe("InstallFinishedDialog optional members", () => {
  it("does not look up optional members while the install is still running", () => {
    renderDialog();
    for (let i = 0; i < 20; i++) {
      addMod(200 + i);
    }

    expect(screen.queryByTestId("install-finished-dialog")).toBeNull();
    expect(lookups()).toBe(0);
  });

  it("looks each optional member up once when the review step opens", () => {
    renderDialog();
    for (let i = 0; i < 20; i++) {
      addMod(200 + i);
    }
    setStep("review");

    expect(screen.getByTestId("install-finished-dialog")).toBeInTheDocument();
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

    expect(screen.queryByTestId("install-finished-dialog")).toBeNull();
    expect(lookups()).toBe(0);
  });

  it("does not look up optional members when no collection is being installed", () => {
    driver.collection = undefined;
    driver.step = "review";
    renderDialog();
    addMod(200);

    expect(screen.queryByTestId("install-finished-dialog")).toBeNull();
    expect(lookups()).toBe(0);
  });
});
