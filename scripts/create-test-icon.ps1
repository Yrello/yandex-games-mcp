Add-Type -AssemblyName System.Drawing

$outputPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts\mcp-test-icon-512.png'
$outputDir = Split-Path $outputPath -Parent
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(512, 512)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function New-RoundRect([int]$x, [int]$y, [int]$width, [int]$height, [int]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

try {
  $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Rectangle]::new(0, 0, 512, 512),
    [System.Drawing.Color]::FromArgb(15, 28, 81),
    [System.Drawing.Color]::FromArgb(64, 36, 143),
    45.0
  )
  $graphics.FillRectangle($background, 0, 0, 512, 512)

  $smallBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(80, 117, 184, 255))
  foreach ($tile in @(@(58, 76, 80), @(370, 74, 68), @(62, 362, 72), @(378, 365, 70))) {
    $shape = New-RoundRect $tile[0] $tile[1] $tile[2] $tile[2] 16
    $graphics.FillPath($smallBrush, $shape)
    $shape.Dispose()
  }

  $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(90, 2, 8, 34))
  $shadow = New-RoundRect 91 111 342 342 54
  $graphics.FillPath($shadowBrush, $shadow)

  $mainRect = [System.Drawing.Rectangle]::new(76, 85, 360, 360)
  $mainBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $mainRect,
    [System.Drawing.Color]::FromArgb(84, 180, 255),
    [System.Drawing.Color]::FromArgb(84, 82, 223),
    45.0
  )
  $main = New-RoundRect 76 85 360 360 54
  $graphics.FillPath($mainBrush, $main)
  $outline = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(165, 218, 255), 5)
  $graphics.DrawPath($outline, $main)

  $font = [System.Drawing.Font]::new('Segoe UI', 91, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString('Demo', $font, $textBrush, [System.Drawing.RectangleF]::new(75, 95, 362, 335), $format)

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $outputPath
} finally {
  foreach ($resource in @($format, $textBrush, $font, $outline, $main, $mainBrush, $shadow, $shadowBrush, $smallBrush, $background, $graphics, $bitmap)) {
    if ($null -ne $resource) { $resource.Dispose() }
  }
}
