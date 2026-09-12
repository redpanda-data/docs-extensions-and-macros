{{- define "type" -}}
{{- $type := . -}}
{{- if asciidocShouldRenderType $type -}}

[id="{{ asciidocTypeID $type | asciidocRenderAnchorID }}"]
== {{ $type.Name  }} {{ if $type.IsAlias }}({{ asciidocRenderTypeLink $type.UnderlyingType  }}) {{ end }}

{{- /* Escape "${" so ${NAME}-style interpolation in a doc comment is not read by AsciiDoc as an
     attribute reference and dropped with a warning. Blanket on purpose: a narrower regex was tried
     and Go's $-expansion in the replacement ate the token. Caveat: shapes AsciiDoc never treats as
     attribute references, such as ${VAR:-default}, would render with a visible backslash. None occur
     in the operator API today; if one appears, move the escape into the Go doc comment instead. */ -}}
{{ $type.Doc | replace "${" "$\\{" }}

{{ if eq $type.Name "RedpandaClusterSpec" }}
For descriptions and default values, see xref:k-redpanda-helm-spec.adoc[].
{{ end }}

{{ if $type.References -}}
.Appears in:

{{- range $type.SortedReferences }}
- {{ asciidocRenderTypeLink . }}
{{- end }}
{{- end }}

{{ if $type.Members -}}
[cols="25a,75a", options="header"]
|===
| Field | Description
{{ if $type.GVK -}}
| *`apiVersion`* __string__ | `{{ $type.GVK.Group }}/{{ $type.GVK.Version }}`
| *`kind`* __string__ | `{{ $type.GVK.Kind }}`
{{ end -}}

{{ range $type.Members -}}
| *`{{ .Name  }}`* __{{ asciidocRenderType .Type }}__ | {{ template "type_members" . }}
{{ end -}}
|===
{{ end -}}

{{- end -}}
{{- end -}}
