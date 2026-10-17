; Register Nawa as an available handler. Windows Settings owns user defaults.
; The upstream APP_ASSOCIATE writes .ext's default and omits executable quotes.
!macroundef APP_ASSOCIATE
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  ; A product-specific class also avoids replacing another app's generic class.
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${APP_ID}.${EXT}"
  !if `${DESCRIPTION}` == ""
    WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}" "" `${FILECLASS}`
  !else
    WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}" "" `${DESCRIPTION}`
  !endif
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}\shell\open" "" `${COMMANDTEXT}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macroundef APP_UNASSOCIATE
!macro APP_UNASSOCIATE EXT FILECLASS
  ; Remove only our own value if it points at the class being removed.
  Push $R9
  ReadRegStr $R9 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${If} $R9 == "${APP_ID}.${EXT}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${EndIf}
  Pop $R9
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${APP_ID}.${EXT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${APP_ID}.${EXT}"
  ; NSIS /ifempty checks subkeys, not values. Leave shared extension containers
  ; intact so other handlers and an existing default cannot be deleted.
!macroend
