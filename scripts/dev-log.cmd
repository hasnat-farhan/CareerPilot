@echo off
setlocal
cd /d "%~dp0\.."
call npm run dev 1>".next-dev.out.log" 2>".next-dev.err.log"
