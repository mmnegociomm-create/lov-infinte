# Infinito Start - launcher visível do ambiente local (AC Agent + OpenCode).
#
# Uso: atalho "Infinito Start" na Área de Trabalho (criado pelo instalador).
#  - Reaproveita a MESMA inicialização do autostart: node.exe + server.mjs
#    com as mesmas variáveis (AC_AGENT_PORT, AC_OPENCODE_BIN, PATH do Git).
#  - O Agent sobe o OpenCode sozinho (mecanismo já existente).
#  - Se o ambiente já estiver rodando, nada novo é iniciado.
#  - A janela permanece aberta exibindo a saída; fechá-la encerra o Agent.
#  - Somente PowerShell nativo, sem dependências.

$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $AppRoot 'agent\node.exe'
$ServerJs = Join-Path $AppRoot 'agent\server.mjs'
$OpenBin = Join-Path $AppRoot 'opencode\opencode.exe'
$GitCmd = Join-Path $AppRoot 'git\cmd'
$AgentPort = 47821
$AgentStatusUrl = "http://127.0.0.1:${AgentPort}/status"
$OpenHealthUrl = 'http://127.0.0.1:4096/global/health'

$host.ui.RawUI.WindowTitle = 'INFINITO ENGINE'

function Test-HttpOk {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $null = Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec
    return $true
  } catch {
    return $false
  }
}

function Show-Header {
  Clear-Host
  Write-Host ''
  Write-Host '  ============================================================'
  Write-Host ''
  Write-Host '                        INFINITO ENGINE' -ForegroundColor White
  Write-Host ''
}

function Show-Online {
  param([string]$Detail)
  Write-Host '                         SISTEMA ONLINE' -ForegroundColor Green
  Write-Host ''
  Write-Host "                     $Detail"
  Write-Host ''
  Write-Host '       Mantenha esta janela aberta enquanto estiver'
  Write-Host '                 utilizando a extensão.'
  Write-Host ''
  Write-Host '  ============================================================'
  Write-Host ''
  $host.ui.RawUI.WindowTitle = 'INFINITO ENGINE - ONLINE'
}

function Wait-Open {
  Read-Host '  Pressione ENTER para fechar esta janela'
}

Show-Header

if (-not (Test-Path -LiteralPath $NodeExe) -or -not (Test-Path -LiteralPath $ServerJs)) {
  Write-Host '  Arquivos do conector não encontrados. Reinstale o Infinitolov.' -ForegroundColor Red
  Wait-Open
  exit 1
}

# Ambiente já em execução: não inicia nada novo.
if ((Test-HttpOk $AgentStatusUrl 2) -and (Test-HttpOk $OpenHealthUrl 3)) {
  Show-Online 'OpenCode já está em execução.'
  Wait-Open
  exit 0
}

Write-Host '  Iniciando sistema...'
Write-Host ''

# Mesmo ambiente do autostart (start-agent-installed.ps1).
$env:AC_AGENT_PORT = "$AgentPort"
$env:AC_OPENCODE_BIN = $OpenBin
$env:PATH = "$GitCmd;$env:PATH"

$job = Start-Job -ScriptBlock {
  param($Node, $Server, $Root)
  Set-Location -LiteralPath $Root
  & $Node $Server
} -ArgumentList $NodeExe, $ServerJs, $AppRoot

# Aguarda o OpenCode responder (o Agent o inicia sozinho).
$deadline = (Get-Date).AddSeconds(60)
$openOk = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if ($job.State -eq 'Failed') { break }
  Receive-Job -Job $job | Out-Host
  if (Test-HttpOk $OpenHealthUrl 3) {
    $openOk = $true
    break
  }
}

if ($openOk -and (Test-HttpOk $AgentStatusUrl 2)) {
  Show-Online 'OpenCode iniciado'
} else {
  Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null
  Write-Host '  Não foi possível iniciar o ambiente. Tente novamente.' -ForegroundColor Red
  Write-Host ''
  Wait-Open
  exit 1
}

# Mantém a janela aberta exibindo a saída do Agent.
# Fechar esta janela encerra o job (e o Agent).
try {
  while ($job.State -eq 'Running') {
    Receive-Job -Job $job | Out-Host
    Start-Sleep -Seconds 1
  }
  Receive-Job -Job $job | Out-Host
} finally {
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null
}
