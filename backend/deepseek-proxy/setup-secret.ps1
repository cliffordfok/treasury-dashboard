Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

Write-Host ""
Write-Host "DeepSeek proxy setup" -ForegroundColor Cyan
Write-Host "This script will not save your API key into the repo." -ForegroundColor Yellow
Write-Host "When Wrangler asks for DEEPSEEK_API_KEY, paste your NEW DeepSeek API key there." -ForegroundColor Yellow
Write-Host ""

if (!(Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm.cmd was not found. Install Node.js first, then run this script again."
}

if (!(Test-Path -LiteralPath "node_modules")) {
  Write-Host "Installing Worker dependencies..."
  npm.cmd install
}

Write-Host ""
Write-Host "Opening Cloudflare login if needed..."
npx.cmd wrangler login

Write-Host ""
Write-Host "Now paste your new DeepSeek API key into Wrangler's secret prompt."
npx.cmd wrangler secret put DEEPSEEK_API_KEY

Write-Host ""
Write-Host "Deploying Worker..."
npx.cmd wrangler deploy

Write-Host ""
Write-Host "Done. Copy the workers.dev URL from the deploy output into GitHub secret VITE_AI_PROXY_URL." -ForegroundColor Green
