@echo off
cd /d "%~dp0"
copy /b Reactive-Avatar-win.zip.001+Reactive-Avatar-win.zip.002+Reactive-Avatar-win.zip.003+Reactive-Avatar-win.zip.004+Reactive-Avatar-win.zip.005+Reactive-Avatar-win.zip.006 Reactive-Avatar-win.zip
certutil -hashfile Reactive-Avatar-win.zip SHA256
echo.
echo Expected SHA256: 1ab45a04d03c3543ae2b66c07e367457a0010f377bcc7359beab7081473e445a
echo Done. Now unzip Reactive-Avatar-win.zip and run "Reactive Avatar.exe"
pause
