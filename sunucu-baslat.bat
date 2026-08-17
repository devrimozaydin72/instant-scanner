@echo off
cd /d "%~dp0"
echo ============================================
echo  INSTANT SCANNER sunucusu baslatiliyor...
echo  Bilgisayarda:  http://localhost:8000
echo.
echo  Telefonda acmak icin ayni Wi-Fi'ye baglan,
echo  asagidaki IPv4 adresini kullan:
ipconfig | findstr /i "IPv4"
echo  Ornek: http://192.168.1.XX:8000
echo ============================================
python -m http.server 8000
pause
