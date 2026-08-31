$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Always delegate validation to the version-aware launcher. It verifies that
# port 8765 belongs to this exact extracted folder and this bridge build.
& (Join-Path $root 'start-workbench.ps1') -NoBrowser
