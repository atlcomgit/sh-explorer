# sh-explorer

Shell scripts explorer for VS Code.

## Features

- Scans the workspace for script files on activation.
- Shows scripts in the Explorer sidebar under “Shell Scripts”.
- Run any script via click or the inline run action; it opens a terminal in the editor area and executes the script.

## Requirements

- Bash available on your system.

## Extension Settings

This extension contributes the following settings:

- `sh-explorer.exclude`: Glob patterns to exclude folders/files from the list.
- `sh-explorer.extensions`: Script file extensions to include (default: `.bat`, `.cmd`, `.sh`).

## Requirements Install extension

To install extension run command:

```bash
ext install alek-fiend.sh-explorer
```

or visit page
[https://marketplace.visualstudio.com/items?itemName=alek-fiend.sh-explorer](https://marketplace.visualstudio.com/items?itemName=alek-fiend.sh-explorer)
