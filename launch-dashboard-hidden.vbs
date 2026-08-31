Option Explicit

Dim shell, fileSystem, root, ensureScript, visibleLauncher, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
ensureScript = fileSystem.BuildPath(root, "ensure-dashboard-service.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ensureScript & """"
visibleLauncher = fileSystem.BuildPath(root, "启动组长工作台.bat")

' Start or reuse the local service without showing a console window.
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
    shell.Run """" & visibleLauncher & """", 1, False
    WScript.Quit exitCode
End If

' Open the dashboard in the default browser.
shell.Run "http://127.0.0.1:8765/", 1, False

