# Source this file to define mpxw. It performs no action when loaded.
mpxw() {
  local destination
  destination="$(mpx workspace show --machine "$@")" || return $?
  [ -n "$destination" ] || return 0
  cd -- "$destination"
}
