Add-Type -AssemblyName System.Drawing

$outputPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts\mcp-test-cover-800x470.png'
$outputDir = Split-Path $outputPath -Parent
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(800, 470)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

try {
  $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Rectangle]::new(0, 0, 800, 470),
    [System.Drawing.Color]::FromArgb(15, 28, 81),
    [System.Drawing.Color]::FromArgb(64, 36, 143),
    25.0
  )
  $graphics.FillRectangle($background, 0, 0, 800, 470)

  $blue = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(77, 155, 249))
  $violet = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(107, 92, 230))
  $light = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(122, 199, 255))
  $graphics.FillRectangle($blue, 487, 63, 180, 180)
  $graphics.FillRectangle($violet, 607, 223, 120, 120)
  $graphics.FillRectangle($light, 470, 279, 92, 92)

  $font = [System.Drawing.Font]::new('Segoe UI', 142, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $graphics.DrawString('Demo', $font, $textBrush, [System.Drawing.PointF]::new(70, 129))

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $outputPath
} finally {
  foreach ($resource in @($textBrush, $font, $light, $violet, $blue, $background, $graphics, $bitmap)) {
    if ($null -ne $resource) { $resource.Dispose() }
  }
}
