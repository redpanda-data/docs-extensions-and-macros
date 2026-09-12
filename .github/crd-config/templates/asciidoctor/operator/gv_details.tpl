{{- define "gvDetails" -}}
{{- $gv := . -}}

{{ $gv.Doc | regexReplaceAll "\\$\\{(\\w[\\w-]*)\\}" "$\\{${1}}" }}

{{- if $gv.Kinds  }}
.Resource Types
{{- range $gv.SortedKinds }}
- {{ $gv.TypeForKind . | asciidocRenderTypeLink }}
{{- end }}
{{ end }}

{{ range $gv.SortedTypes }}
{{ template "type" . }}
{{ end }}

{{- end -}}
