package topic

const defaultPartitions = 3

func newCreateCommand() *cobra.Command {
	var (
		partitions int32
		dryRun     bool
	)
	cmd := &cobra.Command{
		Use:   "create [TOPICS...]",
		Short: "Create topics",
		Run: func(cmd *cobra.Command, args []string) {},
	}
	cmd.Flags().Int32VarP(&partitions, "partitions", "p", defaultPartitions, "Number of partitions to create per topic")
	cmd.Flags().BoolVarP(&dryRun, "dry", "d", false, "Dry run: validate the topic creation request")
	return cmd
}
