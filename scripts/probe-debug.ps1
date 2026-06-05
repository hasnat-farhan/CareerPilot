$u = "https://careerpilot49.netlify.app"
$url = $u + "/api/debug-imports"
Write-Host ("=== GET " + $url + " ===")
try {
  $r = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 30 -UseBasicParsing -Headers @{ "Accept" = "application/json" } -ErrorAction SilentlyContinue
  Write-Host ("STATUS=" + [int]$r.StatusCode + "  CT=" + $r.ContentType + "  BYTES=" + $r.Content.Length)
  Write-Host $r.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $code = [int]$resp.StatusCode
    $ct = $resp.ContentType
    $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    Write-Host ("STATUS=" + $code + "  CT=" + $ct)
    Write-Host $body
  } else {
    Write-Host ("ERROR: " + $_.Exception.Message)
  }
}
