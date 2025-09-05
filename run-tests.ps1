# config
$TotalRuns   = 2048
$Parallelism = 128
$ImagePath   = 'C:\Users\jazza\Downloads\wplace\_extract-4_1757064660338\tiles-4\618\719.png'
$ArgsJson    = '{}'

Set-Location "$HOME\Downloads\wplace\scripts"

$indices = 1..$TotalRuns

$blockTimer = [System.Diagnostics.Stopwatch]::StartNew()

$results = $indices | ForEach-Object -Parallel {
    $i  = $_
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath "./image-processor.exe" `
        -ArgumentList @('count', $using:ImagePath, $using:ArgsJson) `
        -NoNewWindow -PassThru -Wait
    $sw.Stop()

    [pscustomobject]@{
        Run      = $i
        Seconds  = [math]::Round($sw.Elapsed.TotalSeconds, 6)
        ExitCode = $proc.ExitCode
    }
} -ThrottleLimit $Parallelism

$blockTimer.Stop()

# sort for neat output
$results = $results | Sort-Object Run

$results | ForEach-Object {
    Write-Host "Run $($_.Run)"
    Write-Host "Time taken: $($_.Seconds) seconds"
}

$total = ($results | Measure-Object Seconds -Sum).Sum
$avg   = ($results | Measure-Object Seconds -Average).Average
$expectedSerial = $avg * $results.Count
$actualBlock    = $blockTimer.Elapsed.TotalSeconds

Write-Host ""
Write-Host "Total summed times: $([math]::Round($total, 3)) seconds"
Write-Host "Expected serial time (avg × runs): $([math]::Round($expectedSerial, 3)) seconds"
Write-Host "Actual wall-clock time: $([math]::Round($actualBlock, 3)) seconds"
Write-Host "Parallel speedup factor: $([math]::Round(($expectedSerial / $actualBlock), 2))×"
