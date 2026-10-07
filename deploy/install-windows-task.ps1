# Run Fig on this Windows PC automatically: at boot (before anyone logs in) and re-checked every 5 minutes.
# Run once from the claudes_fig folder in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\deploy\install-windows-task.ps1
# Remove with:  Unregister-ScheduledTask -TaskName Fig -Confirm:$false
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\scripts\supervise.js`"" -WorkingDirectory $root
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
# A second start while one is running is refused by supervise.js itself (single-instance lock),
# so the 5-minute trigger only does something when Fig is not running.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName "Fig" -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "Fig"
Write-Host "Fig is registered as a scheduled task and started. Logs: $root\logs\fig.log and crash.log"
Write-Host "Also turn off sleep for this PC (Settings > System > Power) or Fig goes quiet when it sleeps."
