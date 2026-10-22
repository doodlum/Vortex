#!/bin/sh
# Native package removal hook (DEB postrm, RPM %postun, pacman post_remove).
# Upgrades also run it; they must keep the command link. electron-builder's default removed the
# alternative by its link path instead of its target, which RPM distributions treat as a failure.

case "$1" in
  upgrade | failed-upgrade | abort-install | abort-upgrade | disappear) exit 0 ;;
esac
# RPM passes the number of versions left installed; nonzero means an upgrade.
if [ "$1" -eq "$1" ] 2>/dev/null && [ "$1" -gt 0 ]; then
  exit 0
fi

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove vortex /opt/Vortex/vortex >/dev/null 2>&1 || true
fi
if [ -L /usr/bin/vortex ] && [ ! -e /usr/bin/vortex ]; then
  rm -f /usr/bin/vortex
fi
exit 0
