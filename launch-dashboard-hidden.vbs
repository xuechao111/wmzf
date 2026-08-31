Option Explicit

Dim shell, fileSystem, root, ensureScript, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
ensureScript = fileSystem.BuildPath(root, "ensure-dashboard-service.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ensureScript & """"

' Start or reuse the local service without showing a console window.
shell.Run command, 0, True

' Open the dashboard in the default browser.
shell.Run "http://127.0.0.1:8765/", 1, False

