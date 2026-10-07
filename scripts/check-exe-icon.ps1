# MyTerm exe icon check: extract embedded icon and compare with new 32x32.png
Add-Type -AssemblyName System.Drawing

$exe = 'D:/myshell/build-output/MyTerm.exe'
if (-not (Test-Path $exe)) { Write-Output "EXE NOT FOUND: $exe"; exit 1 }

$item = Get-Item $exe
$vi = $item.VersionInfo
Write-Output ("Exe FileVersion: {0}" -f $vi.FileVersion)
Write-Output ("Exe ProductName: {0}" -f $vi.ProductName)
Write-Output ("Exe LastWriteTime: {0}" -f $item.LastWriteTime)

# 1) extract associated icon from exe, draw to 32x32
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$b1 = New-Object System.Drawing.Bitmap 32, 32
$g1 = [System.Drawing.Graphics]::FromImage($b1)
$g1.Clear([System.Drawing.Color]::Transparent)
$g1.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g1.DrawImage($icon.ToBitmap(), 0, 0, 32, 32)
$b1.Save('D:/myshell/build-output/_exe_icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g1.Dispose()

# 2) load new 32x32.png, draw to 32x32
$b2 = New-Object System.Drawing.Bitmap 32, 32
$g2 = [System.Drawing.Graphics]::FromImage($b2)
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage([System.Drawing.Bitmap]::new('D:/myshell/src-tauri/icons/32x32.png'), 0, 0, 32, 32)
$g2.Dispose()

# 3) pixel-by-pixel compare
$diff = 0
$total = 0
for ($x = 0; $x -lt 32; $x++) {
  for ($y = 0; $y -lt 32; $y++) {
    $c1 = $b1.GetPixel($x, $y)
    $c2 = $b2.GetPixel($x, $y)
    $total++
    $d = [math]::Abs([int]$c1.R - [int]$c2.R) + [math]::Abs([int]$c1.G - [int]$c2.G) + [math]::Abs([int]$c1.B - [int]$c2.B) + [math]::Abs([int]$c1.A - [int]$c2.A)
    if ($d -gt 45) { $diff++ }
  }
}
$ratio = [math]::Round($diff / $total * 100, 1)
Write-Output ("Compare: diffPixels {0}/{1} ({2}%)  <5% means same icon" -f $diff, $total, $ratio)
if ($diff -le 8) {
  Write-Output "VERDICT: exe HAS the new icon (difference tiny -> Explorer icon cache issue)"
} else {
  Write-Output "VERDICT: exe STILL has the OLD icon (build did not embed new icon, need forced rebuild)"
}
$b1.Dispose()
$b2.Dispose()
