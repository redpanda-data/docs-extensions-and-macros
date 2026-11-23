// Fixture for the operator lint-strings surface. The call shapes mirror
// redpanda-operator operator/cmd/run/run.go; the strings are the published
// `redpanda-operator run --help` text, some edited to exercise each rule.
package run

import (
	"time"

	"github.com/spf13/cobra"
)

const defaultImage = "docker.redpanda.com/redpandadata/redpanda-operator"

func bindFlags(cmd *cobra.Command, o *options) {
	// Conforming: capitalized, no period, explains the sentinel.
	cmd.Flags().DurationVar(&o.unbindAfter, "unbind-pvcs-after", 0, "How long a Pod must stay Pending before the PVCUnbinder unbinds its PVCs. `0` disables the PVCUnbinder")
	// Plain (non-Var) form bound to a pointer.
	o.lease = cmd.Flags().Duration("leader-election-lease-duration", 15*time.Second, "How long non-leader candidates wait before forcing acquisition of the leader election lease")
	// Var form with no default argument; lowercase start and terminal period.
	cmd.Flags().Var(&o.selector, "unbinder-label-selector", "if provided, a Kubernetes label selector that will filter Pods to be considered by the PVCUnbinder.")
	// Restated defaults, three shapes.
	cmd.Flags().DurationVar(&o.clearAfter, "clear-maintenance-mode-after", 30*time.Minute, "How long a broker may stay down in maintenance mode before the operator clears the flag. Default 30m")
	cmd.Flags().IntVar(&o.percent, "post-restart-caught-up-percent", 100, "The recovery percentage a restarted broker must report (default 100)")
	cmd.Flags().StringVar(&o.image, "configurator-base-image", defaultImage, "The operator image repository, defaults to docker.redpanda.com/redpandadata/redpanda-operator")
	// Deprecated in prose only.
	cmd.Flags().Bool("debug", false, "A deprecated and unused flag")
	// Hidden only: skipped.
	cmd.Flags().BoolVar(&o.unsafe, "unsafe-decommission-failed-brokers", false, "Set to enable decommissioning a failed broker")
	_ = cmd.Flags().MarkHidden("unsafe-decommission-failed-brokers")
	// Deprecated: usage and message are both published.
	cmd.Flags().BoolVar(&o.rebind, "allow-pv-rebinding", false, "Clear the freed PV's ClaimRef when the PVCUnbinder unbinds a PVC")
	_ = cmd.Flags().MarkDeprecated("allow-pv-rebinding", "the PVCUnbinder's safety gates make it unsafe")
	cmd.Flags().Bool("allow-pvc-deletion", false, "Has no effect")
	_ = cmd.Flags().MarkDeprecated("allow-pvc-deletion", "it is ignored and can be removed")
}
