; Puts the install folder, which holds aetherius-cli.exe, on the user's PATH,
; and takes it off again on uninstall. The CLI edits PATH itself: NSIS
; strings stop at 1024 characters, shorter than many PATHs (see
; cli/src/install.rs).

Var CliPathExitCode

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$INSTDIR\aetherius-cli.exe" --add-to-path'
  Pop $CliPathExitCode
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri asks to close a running app only after this hook, and cancelling
  ; there would leave the app installed but off PATH. Ask first instead.
  !ifmacrodef CheckIfAppIsRunning
    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !endif
  nsExec::ExecToLog '"$INSTDIR\aetherius-cli.exe" --remove-from-path'
  Pop $CliPathExitCode
!macroend
