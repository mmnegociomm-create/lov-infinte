' Infinitolov - launcher oculto do Agent (sem janela de console/PowerShell).
' O autostart (Scheduled Task) executa este .vbs via wscript.exe.
' Ele chama start-agent-installed.ps1 oculto, que evita segunda instancia.
Dim sh, appDir, psFile
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName))
psFile = appDir & "\agent\start-agent-installed.ps1"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & psFile & """", 0, False
