# Abre en el Firewall de Windows los puertos del juego (solo red privada).
# Ejecutar UNA vez en el PC anfitrión, en PowerShell como administrador:
#   powershell -ExecutionPolicy Bypass -File scripts\abrir-firewall.ps1

$rules = @(
  @{ Name = 'Horda - servidor de juego (2567)'; Port = 2567 },
  @{ Name = 'Horda - cliente web Vite (5173)'; Port = 5173 }
)

foreach ($r in $rules) {
  if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) {
    Write-Host "Ya existe: $($r.Name)"
  } else {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol TCP -LocalPort $r.Port -Action Allow -Profile Private | Out-Null
    Write-Host "Creada:    $($r.Name)"
  }
}

Write-Host ''
Write-Host 'Comprueba que tu Wi-Fi esté marcada como red PRIVADA (Configuración > Red e Internet > Wi-Fi > Propiedades).'
Write-Host 'Tu IP en la red local:'
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { Write-Host "  $($_.IPAddress)  ($($_.InterfaceAlias))" }
