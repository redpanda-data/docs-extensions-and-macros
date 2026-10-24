package topic

const defaultPartitions = 1

func newCreateCommand() *cobra.Command {
	var (
		partitions int32
		dry        bool
	)
	cmd := &cobra.Command{
		Use:   "create [TOPICS...]",
		Short: "Create topics",
		Run: func(cmd *cobra.Command, args []string) {},
	}
	cmd.Flags().Int32VarP(&partitions, "partitions", "p", defaultPartitions, "Number of partitions to create per topic")
	cmd.Flags().BoolVarP(&dry, "dry", "d", false, "Dry run: validate the topic creation request")
	return cmd
}
