@echo off
chcp 65001 >nul
title Sistema Alta Performance - Direito Bancario
cd /d "%~dp0"

echo ==========================================================
echo   Iniciando Sistema de Metricas e Vendas (Direito Bancario)
echo   Integração: Firebase + Google Planilhas + Google Agenda
echo ==========================================================
echo.

REM Verifica se a porta 3000 ja esta em uso
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo Servidor ja esta rodando em http://localhost:3000
    start "" "http://localhost:3000"
    exit /b 0
)

start "" "http://localhost:3000"
node "%~dp0server.js"
pause
