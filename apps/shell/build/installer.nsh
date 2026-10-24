; Keeps the genoffice command line (resources\cli, holding genoffice.cmd and the
; extension-less genoffice for Git Bash) on the installing user's PATH for the
; lifetime of the install. The value is read and written unexpanded
; (REG_EXPAND_SZ) so entries such as %USERPROFILE%\bin survive, and Explorer
; is told about the change so terminals opened afterwards see it.
; electron-builder compiles the script twice (the second pass, with
; BUILD_UNINSTALLER, only produces the uninstaller); an unreferenced function
; in either pass is a warning makensis treats as an error, hence the guards.
!include "WinMessages.nsh"
!include "StrFunc.nsh"

!define GENOFFICE_PATH_MAX 7900

!ifndef BUILD_UNINSTALLER
; This runs before the install section writes application files. It is also
; used during updates; a valid existing approval returns without showing UI.
; Silent deployment accepts /NAWALICENSE=FILE. /NAWAREQUEST=FILE exports a
; request and exits without installing; /NAWASOFTWARE explicitly requests the
; weaker software-key alternative for administrator review.
!macro customInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\nawa-license.exe "${BUILD_RESOURCES_DIR}\offline-license\nawa-license.exe"
  ${GetParameters} $R0
  ; Forward the original arguments so the native helper uses Windows quoting
  ; rules, including fully quoted /OPTION=path tokens with embedded spaces.
  ${If} ${Silent}
    nsExec::ExecToStack '"$PLUGINSDIR\nawa-license.exe" installer $R0'
    Pop $0
    Pop $1
  ${Else}
    ClearErrors
    ExecWait '"$PLUGINSDIR\nawa-license.exe" installer $R0' $0
    ${If} ${Errors}
      StrCpy $0 3
    ${EndIf}
  ${EndIf}
  ${If} $0 == 10
    ; Request collection and approval-only preflight never install files.
    SetErrorLevel 0
    Quit
  ${EndIf}
  ${If} $0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "Nawa was not installed. This PC and Windows account need a valid signed approval."
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TEXT "Nawa is installed. On first launch, choose separate downloads for chat, embeddings, llama.cpp, and Office conversion. Setup needs internet access; selecting all components can require about 12 GiB free disk space."
  !ifndef HIDE_RUN_AFTER_FINISH
    Function NawaStartAfterSetup
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--nawa-setup"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "NawaStartAfterSetup"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif

; electron-builder emits its association macros before customHeader expands.
; Override them there so Open With registration never claims a user's defaults
; and executable paths containing spaces remain valid Windows commands.
!macro customHeader
  !include "${BUILD_RESOURCES_DIR}\file-associations.nsh"
!macroend

; Scope templates to the product-specific ProgIDs from file-associations.nsh.
; A shared .ext\ShellNew would overwrite Office/WPS templates. OOXML files
; must be copied from valid packages, never created with NullFile.
!macro GenOfficeRegisterShellNew EXT PROGID
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName" "$INSTDIR\resources\shell-new\blank.${EXT}"
!macroend

!macro GenOfficeUnregisterShellNew EXT PROGID
  ; Only remove our own registration, including when uninstalling for an update.
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName"
  ${If} $0 == "$INSTDIR\resources\shell-new\blank.${EXT}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}"
  ${EndIf}
!macroend

!macro customInstall
  Push "$INSTDIR\resources\cli"
  Call GenOfficeAddToUserPath
  !insertmacro GenOfficeRegisterShellNew "docx" "${APP_ID}.docx"
  !insertmacro GenOfficeRegisterShellNew "xlsx" "${APP_ID}.xlsx"
  !insertmacro GenOfficeRegisterShellNew "pptx" "${APP_ID}.pptx"
  !insertmacro UPDATEFILEASSOC
!macroend

!macro customUnInstall
  Push "$INSTDIR\resources\cli"
  Call un.GenOfficeRemoveFromUserPath
  Push $0
  !insertmacro GenOfficeUnregisterShellNew "docx" "${APP_ID}.docx"
  !insertmacro GenOfficeUnregisterShellNew "xlsx" "${APP_ID}.xlsx"
  !insertmacro GenOfficeUnregisterShellNew "pptx" "${APP_ID}.pptx"
  Pop $0
  !insertmacro UPDATEFILEASSOC
!macroend

!ifndef BUILD_UNINSTALLER
${StrStr}

Function GenOfficeAddToUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  Push $3
  ReadRegStr $1 HKCU "Environment" "Path"
  StrLen $2 $1
  ; leave an already oversized PATH alone rather than truncate it
  IntCmp $2 ${GENOFFICE_PATH_MAX} done 0 done
  ${StrStr} $3 ";$1;" ";$0;"
  StrCmp $3 "" 0 done
  StrCmp $1 "" 0 +3
    StrCpy $1 "$0"
    Goto write
  StrCpy $1 "$1;$0"
write:
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
${UnStrStr}
${UnStrRep}

Function un.GenOfficeRemoveFromUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCmp $1 "" done
  ${UnStrStr} $2 ";$1;" ";$0;"
  StrCmp $2 "" done
  StrCpy $1 ";$1;"
  ${UnStrRep} $1 $1 ";$0;" ";"
  ; strip the sentinels added above
  StrCpy $1 $1 -1
  StrCpy $1 $1 "" 1
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
