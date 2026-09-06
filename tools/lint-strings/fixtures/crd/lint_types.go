// Package v1alpha2 is a lint-strings test fixture mirroring the operator
// API type shapes. It only needs to parse as Go text for the scanner.
package v1alpha2

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WidgetSpec defines the configuration of a fixture widget.
type WidgetSpec struct {
	// ClusterSource is a reference to the cluster hosting the widget.
	// It leads with the Go field name, which users never type.
	// +required
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="ClusterSource is immutable"
	ClusterSource *ClusterSource `json:"cluster"`
	// Text is the actual unescaped text of a widget. The Go name matches
	// the json name (case only), so this conforms.
	// +required
	Text string `json:"text,omitempty"`
	// Specifies how many replicas to run. Conforming: describes behavior,
	// never names the field.
	// +kubebuilder:default=3
	Replicas *int `json:"replicas,omitempty"`
	// +hidefromdoc
	// Internal knob hidden from the docs; never linted.
	HiddenKnob string `json:"hiddenKnob,omitempty"`
	NotSerialized string `json:"-"`
}

// WidgetReference is a way for one widget to reference another. Its fields
// are undocumented on purpose (the known-bad this fixture exists for).
type WidgetReference struct {
	Name    string `json:"name"`
	Subject string `json:"subject"`
	Version int    `json:"version"`
}

// EmptyOnOneLine opens and closes on a single line. Assuming it opened a
// struct body left the parser inside a type that had already ended, which
// dropped every declaration below it in the file.
type EmptyOnOneLine struct{}

// ValueSource represents where a value can be pulled from.
type ValueSource struct {
	// The literal value.
	Value string `json:"value,omitempty"`
}

// UndocumentedType has no doc comment of its own, so a field referencing it
// has nothing to inherit and genuinely ships blank.
type undocumentedTypeMarker int

type UndocumentedTarget struct {
	// The only field.
	Only string `json:"only,omitempty"`
}

// FallbackSpec covers what an uncommented field actually publishes.
type FallbackSpec struct {
	// +optional
	Inherited *ValueSource `json:"inherited,omitempty"`
	// +optional
	FromUndocumented *UndocumentedTarget `json:"fromUndocumented,omitempty"`
	// +optional
	Primitive string `json:"primitive,omitempty"`
	// +optional
	SliceOfDocumented []ValueSource `json:"sliceOfDocumented,omitempty"`
	// +optional
	External *metav1.Duration `json:"external,omitempty"`
	// How long to wait before giving up on the widget.
	// +optional
	Both *ValueSource `json:"both,omitempty"`
}

// WidgetList is ignored via the config's ignoreTypes ('List$').
type WidgetList struct {
	metav1.TypeMeta `json:",inline"`
	UndocumentedButIgnored string `json:"items"`
}

// DeprecatedWidget matches ignoreTypes ('Deprecated.*$').
type DeprecatedWidget struct {
	Old string `json:"old"`
}

// +hidefromdoc
// HiddenStruct is hidden from the docs wholesale.
type HiddenStruct struct {
	Anything string `json:"anything"`
}

func (w *WidgetSpec) helper() bool { // functions between types must not confuse the parser
	return w != nil && len(w.Text) > 0
}
