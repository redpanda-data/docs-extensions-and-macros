{{- define "type_members" -}}
{{- $field := . -}}
{{- if eq $field.Name "metadata" -}}
Refer to the Kubernetes API documentation for fields of `metadata`.
{{ else -}}
{{- /* Escape "${" so ${NAME}-style interpolation in a doc comment is not read by AsciiDoc as an
     attribute reference and dropped with a warning. Blanket on purpose: a narrower regex was tried
     and Go's $-expansion in the replacement ate the token. Caveat: shapes AsciiDoc never treats as
     attribute references, such as ${VAR:-default}, would render with a visible backslash. None occur
     in the operator API today; if one appears, move the escape into the Go doc comment instead. */ -}}
{{ asciidocRenderFieldDoc $field.Doc | replace "${" "$\\{" }}
{{- end -}}
{{- end -}}
