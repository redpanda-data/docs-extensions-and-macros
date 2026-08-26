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
