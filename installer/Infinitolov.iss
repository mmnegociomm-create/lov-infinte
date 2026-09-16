; Infinitolov - instalador Windows user-level (Inno Setup).
; Infraestrutura local somente: Agent + Node privado + OpenCode + Git privado.
; Sem admin/UAC, sem extensao, sem licenca, sem backend, sem updater.
; Destino padrao: {localappdata}\Infinitolov

#define AppVersion "0.1.2"
#define DevTest "C:\Users\manoe\AppData\Local\Infinitolov-devtest"

[Setup]
AppId={{C9D14B2A-7E3F-4A1B-9C5D-8E6F0A1B2C3D}
AppName=Infinitolov
AppVersion={#AppVersion}
AppPublisher=Infinitolov
DefaultDirName={localappdata}\Infinitolov
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
SolidCompression=yes
Compression=lzma2/max
UninstallDisplayName=Infinitolov
OutputDir=output
OutputBaseFilename=Infinitolov-Setup-{#AppVersion}
DisableProgramGroupPage=yes
WizardStyle=modern

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
; Agent + Node privado (sem config.json/github.json/tokens/logs de dev)
Source: "..\agent\server.mjs"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "scripts\start-agent-installed.ps1"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "scripts\launch-agent.vbs"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "scripts\start-infinito.ps1"; DestDir: "{app}\agent"; Flags: ignoreversion
Source: "{#DevTest}\agent\node.exe"; DestDir: "{app}\agent"; Flags: ignoreversion
; OpenCode privado
Source: "{#DevTest}\opencode\opencode.exe"; DestDir: "{app}\opencode"; Flags: ignoreversion
; Git privado (PortableGit completo)
Source: "{#DevTest}\git\*"; DestDir: "{app}\git"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; Dados do usuario: criados no primeiro install, NUNCA apagados no uninstall
Name: "{app}\projects"; Flags: uninsneveruninstall
Name: "{app}\logs"; Flags: uninsneveruninstall
Name: "{app}\data"; Flags: uninsneveruninstall

[Icons]
; Launcher visível do ambiente local (Agent + OpenCode). Removido no uninstall.
Name: "{autodesktop}\Infinito Start"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\agent\start-infinito.ps1"""; WorkingDir: "{app}"; Comment: "Inicia o ambiente local do Infinitolov (Agent + OpenCode)"

[Code]
const
  TaskName = 'InfinitolovAgent';

{ Para SOMENTE processos do Infinitolov: node.exe/opencode.exe cujo caminho
  está dentro da pasta de instalação. Nunca toca em homônimos de outros
  programas. Evita o popup de "arquivos em uso" (opencode.exe = runtime Bun). }
procedure StopInfinitolovProcesses();
var
  Locator, Service, Procs, Proc: Variant;
  AppDir, ExePath: String;
  I: Integer;
begin
  AppDir := Lowercase(ExpandConstant('{app}')) + '\';
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\cimv2');
    Procs := Service.ExecQuery('SELECT ProcessId, Name, ExecutablePath FROM Win32_Process WHERE Name="node.exe" OR Name="opencode.exe"');
    for I := 0 to Procs.Count - 1 do
    begin
      Proc := Procs.ItemIndex(I);
      try
        ExePath := Proc.ExecutablePath;
        if (ExePath <> '') and (Pos(AppDir, Lowercase(ExePath)) = 1) then
          Proc.Terminate();
      except
      end;
    end;
  except
  end;
end;

{ Autostart via API do Agendador de Tarefas (PowerShell oculto), que funciona
  sem administrador. schtasks.exe /Create exige elevação (código 1) e por isso
  NÃO é usado. O argumento do wscript vai SEM aspas internas: o Agendador
  repassa Arguments direto ao CreateProcess (sem camada cmd), então aspas
  extras são literalmente incorporadas e quebram a execução. }
function BuildAutostartCommand(): String;
var
  Wscript, Vbs: String;
begin
  Wscript := ExpandConstant('{sys}\wscript.exe');
  Vbs := ExpandConstant('{app}\agent\launch-agent.vbs');
  Result :=
    '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "'
    + 'try { $a=New-ScheduledTaskAction -Execute ''' + Wscript + ''' -Argument ''' + Vbs + '''; '
    + '$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; '
    + '$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; '
    + 'Register-ScheduledTask -TaskName ''' + TaskName + ''' -Action $a -Trigger $t -Settings $s -Force | Out-Null; exit 0 } '
    + 'catch { exit 1 }"';
end;

function RemoveAutostartCommand(): String;
begin
  Result :=
    '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "'
    + 'try { Unregister-ScheduledTask -TaskName ''' + TaskName + ''' -Confirm:$false -ErrorAction Stop | Out-Null } catch { }"';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    { Update por cima: para Agent/OpenCode privados ANTES de copiar arquivos. }
    StopInfinitolovProcesses();
  end;
  if CurStep = ssPostInstall then
  begin
    { Autostart user-level (task At Logon, sem admin). Falha NÃO é ignorada. }
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), BuildAutostartCommand(), '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox('Infinitolov: não foi possível registrar o autostart do conector (falha ao executar o registro). O conector foi iniciado agora, mas pode não iniciar sozinho na próxima entrada.', mbError, MB_OK);
    end
    else if ResultCode <> 0 then
    begin
      MsgBox('Infinitolov: não foi possível registrar o autostart do conector (código ' + IntToStr(ResultCode) + '). O conector foi iniciado agora, mas pode não iniciar sozinho na próxima entrada.', mbError, MB_OK);
    end;
    { Inicia o Agent agora, oculto; o script evita segunda instancia e sobe o OpenCode sozinho. }
    Exec(ExpandConstant('{sys}\wscript.exe'), ExpandConstant('"{app}\agent\launch-agent.vbs"'), '', SW_HIDE, ewNoWait, ResultCode);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { Para os processos privados antes de remover arquivos. }
    StopInfinitolovProcesses();
    { Remove SOMENTE o autostart criado pelo instalador. projects/logs/data ficam (uninsneveruninstall). }
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), RemoveAutostartCommand(), '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
