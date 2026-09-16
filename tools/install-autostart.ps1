<#
  MT5 web control - autostart installer (no administrator rights needed)

  Puts a shortcut in your Windows Startup folder so the control server is
  already running (minimised) whenever you log in. That way the only thing you
  ever click is START / STOP on the web page.

  Usage (normally you just double-click install-autostart.cmd):

    powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Remove
    powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -StartupFolder C:\temp\test
#>
[CmdletBinding()]
param(
  [string]$StartupFolder = '',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent (Split-Path -Parent $scriptDir)
$serverJs  = Join-Path $root 'server\server.js'
$launcher  = Join-Path $root 'server\run-server.cmd'
$linkName  = 'MT5 Web Control Server.lnk'

if (-not (Test-Path $serverJs)) {
  throw "Cannot find the control server at $serverJs"
}
if (-not (Test-Path $launcher)) {
  throw "Cannot find the launcher at $launcher"
}

if ([string]::IsNullOrWhiteSpace($StartupFolder)) {
  $StartupFolder = [Environment]::GetFolderPath('Startup')
}
$linkPath = Join-Path $StartupFolder $linkName

Write-Host ''
Write-Host 'MT5 web control - autostart installer'
Write-Host ('  project  : ' + $root)
Write-Host ('  startup  : ' + $StartupFolder)
Write-Host ''

if ($Remove) {
  if (Test-Path $linkPath) {
    Remove-Item $linkPath -Force
    Write-Host ('REMOVED  ' + $linkPath)
  } else {
    Write-Host ('Nothing to remove (' + $linkPath + ' does not exist)')
  }
  Write-Host 'The server will no longer start with Windows.'
  Write-Host ''
  return
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  Write-Host ('  node     : ' + $nodeCmd.Source)
} else {
  Write-Warning 'node.exe is not on PATH. Install Node.js 18+ or the shortcut will do nothing.'
}

if (-not (Test-Path $StartupFolder)) {
  New-Item -ItemType Directory -Path $StartupFolder -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath       = $launcher
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle      = 7          # 7 = start minimised
$shortcut.Description      = 'Starts the MT5 web control server (start/stop your EA from a web page)'
$shortcut.IconLocation     = "$env:SystemRoot\System32\shell32.dll,167"
$shortcut.Save()

# read it back so we can prove what was created
$check = $shell.CreateShortcut($linkPath)
Write-Host ('CREATED  ' + $linkPath)
Write-Host ('  target : ' + $check.TargetPath)
Write-Host ('  workdir: ' + $check.WorkingDirectory)
Write-Host ''
Write-Host 'Next logon the server starts by itself (minimised).'
Write-Host 'To use it now, double-click server\run-server.cmd.'
Write-Host 'To undo: run uninstall-autostart.cmd.'
Write-Host ''