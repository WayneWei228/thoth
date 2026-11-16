# Join this Windows computer to the user's brain. Served by the brain (a cloud brain, or the device
# listener of a brain computer on the same network):
#   & ([scriptblock]::Create((iwr -UseBasicParsing https://<cloud brain>/join.ps1).Content)) -HubUrl https://<cloud brain> [code] [name]
#   & ([scriptblock]::Create((iwr -UseBasicParsing http://<brain computer>/join.ps1).Content)) <code> [name]
# A cloud brain without a code: this computer asks to join and waits for Approve on the owner's panel.
# Needs Python 3 (py -3 or python). Puts two files in %USERPROFILE%\.cc-brain and pushes every 5 minutes.
param([string]$Code = "", [string]$Name = "", [string]$HubUrl = "")
$ErrorActionPreference = "Stop"
$Hub = "__HUB__"
# -HubUrl: the brain's address when the file is served as it is (a static file on the cloud brain)
if ($HubUrl) { $Hub = $HubUrl.TrimEnd("/") }
if (-not ($Hub.StartsWith("http://") -or $Hub.StartsWith("https://"))) { Write-Host "The brain's address is missing. Copy the whole command from the setup page again."; exit 2 }
# one argument that is not a code is the name ("... join.ps1 work-pc")
if ($Code -and $Code -notmatch '^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}(-[A-Za-z0-9]{2})?$' -and -not $Name) { $Name = $Code; $Code = "" }
if (-not $Code -and -not $Hub.StartsWith("https://")) { Write-Host "Usage: join.ps1 <code> [name]   (the code is on the setup page)"; exit 2 }
$py = $null
# Rest of a command array, without the null entries that $c[1..9] gives for a short array.
function Rest($a) { if ($a.Count -gt 1) { $a[1..($a.Count - 1)] } else { @() } }
foreach ($c in @(@("py", "-3"), @("python"), @("python3"))) {
  # The Microsoft Store "python.exe" stub fails here, so it counts as missing.
  try { & $c[0] @(Rest $c) --version *> $null; if ($LASTEXITCODE -eq 0) { $py = $c; break } } catch {}
}
if (-not $py) { Write-Host "Python 3 is missing. Install it from https://www.python.org/downloads/ (tick 'Add to PATH') and run the command again."; exit 1 }
$D = Join-Path $env:USERPROFILE ".cc-brain"; New-Item -ItemType Directory -Force -Path $D | Out-Null
Invoke-WebRequest -UseBasicParsing "$Hub/device/collector.py" -OutFile (Join-Path $D "collector.py")
Invoke-WebRequest -UseBasicParsing "$Hub/device/device_agent.py" -OutFile (Join-Path $D "device_agent.py")
$agent = Join-Path $D "device_agent.py"
$args2 = @("join", $Hub); if ($Code) { $args2 += @($Code) }; if ($Name) { $args2 += @("--name", $Name) }
$pyArgs = @(Rest $py)
& $py[0] @pyArgs $agent @args2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $env:CC_DEVICE_NO_SCHEDULE) {
  # pythonw.exe has no console window, so nothing flashes every 5 minutes
  $exe = (Get-Command $py[0]).Source
  $argline = (($pyArgs + @("`"$agent`"", "push")) -join " ").Trim()
  try {
    $real = (& $py[0] @pyArgs -c "import sys;print(sys.executable)").Trim()
    $w = Join-Path (Split-Path $real) "pythonw.exe"
    if (Test-Path $w) { $exe = $w; $argline = "`"$agent`" push" }
  } catch {}
  $action = New-ScheduledTaskAction -Execute $exe -Argument $argline
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
  # A laptop on battery must still send; a missed run starts when the PC wakes.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName "ClaudePanelDeviceAgent" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Sessions are sent every 5 minutes (scheduled task ClaudePanelDeviceAgent)."
}
& $py[0] @pyArgs $agent push
