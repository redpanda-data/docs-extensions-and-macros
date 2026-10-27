// Fixture: verbatim rows excerpted from docs-team-standards
// resources/writing-style/terminology.md (the file the workflow fetches).
// Presented to the eval model as that file's content.

| Term | Guideline | Example |
|---|---|---|
| broker | A Redpanda broker acts as a server that processes write requests from producers, and read requests from consumers. A Redpanda broker is a process that runs on a node. Sometimes referred to as a Redpanda node. | rpk commands use the term broker. For example, `rpk redpanda admin brokers [command]` |
| Redpanda | Name of our product. You can also use to refer to the company when there is no confusion. Always capitalize the first letter, do not make it into two words, and do not capitalize the p. | Correct: Redpanda. Incorrect: RedPanda, redpanda, Red panda |
| `rpk` | Redpanda's CLI tool, Redpanda Keeper. Refer to as `rpk`, not Redpanda Keeper. Always use lowercase letters and monospace font. Even if it is the first word in a sentence, use lowercase letters. | Correct: `rpk`. Incorrect: Rpk, RPK, rpk (without backticks) |
| Shadow Indexing | Redpanda feature. Always spell out both words and capitalize the first letter of each word. | Correct: Shadow Indexing. Incorrect: Shadow indexing, shadow indexing, SI |
