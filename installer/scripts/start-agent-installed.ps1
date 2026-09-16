# AC Agent (instalado) - inicializacao oculta, sem segunda instancia.
# Alvo final: %LOCALAPPDATA%\Infinitolov\agent\node.exe + server.mjs
# - Sonda http://127.0.0.1:47821/status; se online, sai sem iniciar nada.
# - Define AC_OPENCODE_BIN=<app>\opencode\opencode.exe e PATH com <app>\git\cmd.
# - Inicia UMA instancia destacada via WMI (sem janela visivel).
# - Logs em <app>\logs\agent.log. Nunca espera o node encerrar.

param(
  [int]$Port = 47821,
  [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $AppRoot 'logs'
try { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null } catch {}
$LogFile = Join-Path $LogDir 'agent.log'
$statusUrl = "http://127.0.0.1:${Port}/status"

function Test-AgentOnline {
  try {
    $null = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Get-ListenerPid {
  try {
    $line = netstat -ano | Select-String -Pattern 'LISTENING' | Select-String -Pattern (":${Port}\s") | Select-Object -First 1
    if ($line) { return ($line.ToString().Trim() -split '\s+')[-1] }
  } catch {}
  return 'N/A'
}

if (Test-AgentOnline) {
  Write-Output ('AGENT_ALREADY_ONLINE pid=' + (Get-ListenerPid))
  exit 0
}

$nodePath = Join-Path $AppRoot 'agent\node.exe'
$serverPath = Join-Path $AppRoot 'agent\server.mjs'
if (-not (Test-Path -LiteralPath $nodePath)) {
  Write-Output 'AGENT_START_FAILED missing-node'
  exit 1
}
if (-not (Test-Path -LiteralPath $serverPath)) {
  Write-Output 'AGENT_START_FAILED missing-server'
  exit 1
}

$psExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$gitCmd = Join-Path $AppRoot 'git\cmd'
$openBin = Join-Path $AppRoot 'opencode\opencode.exe'
$inner = '$env:AC_AGENT_PORT=' + $Port + '; $env:AC_OPENCODE_BIN=' + "'" + $openBin + "'; " + '$env:PATH=' + "'" + $gitCmd + ';' + "'" + ' + $env:PATH; & ' + "'" + $nodePath + "' '" + $serverPath + "' >> '" + $LogFile + "' 2>&1"
$cmdLine = '"' + $psExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + $inner + '"'

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $AppRoot }
if ($result.ReturnValue -ne 0) {
  Write-Output ('AGENT_START_FAILED wmi=' + $result.ReturnValue)
  exit 1
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
do {
  Start-Sleep -Milliseconds 500
  if (Test-AgentOnline) {
    Write-Output ('AGENT_ONLINE pid=' + (Get-ListenerPid))
    exit 0
  }
} while ((Get-Date) -lt $deadline)

Write-Output 'AGENT_START_TIMEOUT'
exit 1
