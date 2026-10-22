{
  description = "Vortex Linux development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/master";
    flake-utils.url = "github:numtide/flake-utils";
    flake-compat = {
      url = "github:NixOS/flake-compat";
      flake = false;
    };
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        entry = pkgs.writeShellScript "vortex-dev-entry" ''
          if [ "$#" -eq 0 ]; then
            exec bash
          fi
          exec "$@"
        '';
        environment = pkgs.buildFHSEnv {
          name = "vortex-dev";
          runScript = entry;
          extraOutputsToInstall = [ "dev" ];
          targetPkgs = p: with p; [
            # These bootstrap pnpm; the repository retains its own runtime pins.
            nodejs_24
            pnpm
            (python3.withPackages (ps: [ ps.setuptools ]))
            gitMinimal
            gnumake
            cmake
            ninja
            pkg-config
            clang
            llvmPackages.libcxx

            # Optional distribution build tools.
            flatpak
            flatpak-builder
            appstream

            # Vendor Node/Electron and native addons resolve these via FHS paths.
            cairo
            pango
            libgbm
            expat
            udev
            gtk3
            gtk4
            glib
            gsettings-desktop-schemas
            dconf
            librsvg
            nss
            nspr
            alsa-lib
            at-spi2-core
            dbus
            cups
            libdrm
            libxkbcommon
            libsecret
            libuuid
            zlib
            fontconfig
            freetype
            libglvnd
            mesa
            libx11
            libxcomposite
            libxcursor
            libxdamage
            libxext
            libxfixes
            libxi
            libxrandr
            libxrender
            libxscrnsaver
            libxtst
            libxcb
            libxshmfence
            xdg-utils
          ];
          profile = ''
            # The FHS /usr/share shadows host fonts; keep a usable fallback.
            export FONTCONFIG_FILE="${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }}"
            export CC="${pkgs.clang}/bin/clang"
            export CXX="${pkgs.clang}/bin/clang++"
            export E2E_PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.gtk4}/share/gsettings-schemas/${pkgs.gtk4.name}:${pkgs.glib}/share:''${XDG_DATA_DIRS:-}"
            export GIO_EXTRA_MODULES="${pkgs.dconf.lib}/lib/gio/modules"
            export GDK_PIXBUF_MODULE_FILE="${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"

            # Also expose the workspace Electron to the existing debugger profile.
            vortex_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
            if [ -n "$vortex_root" ] && [ -f "$vortex_root/pnpm-workspace.yaml" ]; then
              export PATH="$vortex_root/src/main/node_modules/.bin:$vortex_root/node_modules/.bin:$PATH"
            fi
            unset vortex_root
          '';
        };
      in pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
        # Interactive shell; use the app below for noninteractive argv forwarding.
        devShells.default = environment.env;
        # direnv cannot move its parent shell into an FHS mount namespace.
        devShells.tools = pkgs.mkShell {
          packages = [ environment ];
        };
        packages.default = environment;
        apps.default = {
          type = "app";
          program = "${environment}/bin/vortex-dev";
        };
      });
}
