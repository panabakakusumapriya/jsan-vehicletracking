# One-time setup on a new PC: a private Python environment for the VTS sync tool, and its packages.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (Get-Command uv -ErrorAction SilentlyContinue) {
  uv venv .venv --python 3.11
  uv pip install --python .venv\Scripts\python.exe -r requirements.txt
} else {
  py -3 -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
}
Write-Host "Done. Start it with: .venv\Scripts\pythonw.exe vts_sync.py"
