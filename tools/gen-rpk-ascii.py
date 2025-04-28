import subprocess
import re
import json
import os
import filecmp
import difflib
import sys

suggestedReadings = """

---

<SuggestedReading/>

- [Introducing rpk container](https://redpanda.com/blog/rpk-container/)
- [Getting started with rpk commands](https://redpanda.com/blog/getting-started-rpk/)
"""


cmd_dict = {}
basic_commands_docker = ["docker","exec","-it"]
basic_commands_docker.append("redpanda-1")
rpk_basic_command = ["rpk"]

def assert_period(s):return s if s.endswith('.') else s + '.'

def escape_chars(s):

    s = s.replace("./<timestamp>-bundle.zip", "./&lt;timestamp&gt;-bundle.zip")
    return s

def cmp_rpk_ascii(dir1, dir2, outdir=""):
    if outdir:
        for root1, _, files1 in os.walk(dir1):
            for file1 in files1:
                for root2, _, files2 in os.walk(dir2):
                    for file2 in files2:
                        if file1 == file2:
                            file_path1 = os.path.join(root1, file1)
                            file_path2 = os.path.join(root2, file2)
                            if not filecmp.cmp(file_path1, file_path2, shallow=False):
                                with open(file_path1, "r") as f1, open(file_path2, "r") as f2:
                                    lines1 = f1.readlines()
                                    lines2 = f2.readlines()
                                diff = difflib.unified_diff(lines1, lines2, file_path1, file_path2)
                                outfile = outdir + "/diff_" + os.path.basename(file_path1)
                                with open(outfile, "w") as fo:
                                    fo.write("\n".join(diff))
                                    print("Wrote " + outfile)

class Flag:
    def __init__(self, value: str, flag_type: str, explanation: str):
        self.value = value
        self.flag_type = flag_type
        self.explanation = explanation


# Execute a subprocess inside a Linux machine. If the command is multi level (ex. rpk acl create) is generates a bigger list
def execute_process(commands):
    if len(commands) > 0:
        commands = commands[0].split(" ")
    commands_to_execute = basic_commands_docker + rpk_basic_command + commands
    commands_to_execute.append("-h")
    try:
        process = subprocess.run(
            commands_to_execute,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return process.stdout.decode("utf-8")
    except subprocess.CalledProcessError as e:
        print(f"Error executing command: {' '.join(commands_to_execute)}")
        print(f"Error message: {e.stderr.decode('utf-8')}")
        sys.exit(1)


# Get the explanation written before the usage. Example:
""" # rpk is the Redpanda CLI & toolbox.
# Usage:
#   rpk [command] """


def get_explanation(process_line):
    explanation_line = process_line[: process_line.find("Usage")].rstrip("\n").strip()
    explanation_line = explanation_line.replace("redpanda.yaml","`redpanda.yaml`")
    return explanation_line


# Get the usage of the command. If it's initial command, look for available commands. If it's a final a command, then look for flags. Finally if neither are present, extract the usage. Example:
""" Usage:
  rpk [command]

Available Commands:
  acl         Manage ACLs and SASL users.
  cluster     Interact with a Redpanda cluster.
  container   Manage a local container cluster.
  debug       Debug the local Redpanda process.
  generate    Generate a configuration template for related services.
  group       Describe, list, and delete consumer groups and manage their offsets.
  help        Help about any command
  iotune      Measure filesystem performance and create IO configuration file.
  plugin      List, download, update, and remove rpk plugins.
  redpanda    Interact with a local Redpanda process
  topic       Create, delete, produce to and consume from Redpanda topics.
  version     Check the current version.
  wasm        Deploy and remove inline WASM engine scripts. """


def get_usage(process_line):
    if process_line.find("Available Commands:") != -1:
        return process_line[
            process_line.find("Usage") : process_line.find("Available Commands:")
        ].rstrip("\n")
    elif process_line.find("Flags:") != -1:
        return process_line[
            process_line.find("Usage") : process_line.find("Flags:")
        ].rstrip("\n")
    else:
        return process_line[process_line.find("Usage") :].rstrip("\n")


# Get lines for possible available commands. Example:
""" Usage:
  rpk [command]

Available Commands:
  acl         Manage ACLs and SASL users.
  cluster     Interact with a Redpanda cluster.
  container   Manage a local container cluster.
  debug       Debug the local Redpanda process.
  generate    Generate a configuration template for related services.
  group       Describe, list, and delete consumer groups and manage their offsets.
  help        Help about any command
  iotune      Measure filesystem performance and create IO configuration file.
  plugin      List, download, update, and remove rpk plugins.
  redpanda    Interact with a local Redpanda process
  topic       Create, delete, produce to and consume from Redpanda topics.
  version     Check the current version.
  wasm        Deploy and remove inline WASM engine scripts. """


def get_commands(process_line):
    if process_line.find('Use "rpk') != -1:
        full_command = process_line[
            process_line.find("Available Commands:") : process_line.find('Use "rpk')
        ]
    else:
        full_command = process_line[process_line.find("Available Commands:") :]
    commands = full_command[: full_command.find("Flags:")]
    prefix = "Available Commands:"
    return commands[len(prefix):] if commands.startswith(prefix) else commands

# Extract lines for the flags from a command. Example:
""" Available Commands:
  acl         Manage ACLs and SASL users.
  cluster     Interact with a Redpanda cluster.
  container   Manage a local container cluster.
  debug       Debug the local Redpanda process.
  generate    Generate a configuration template for related services.
  group       Describe, list, and delete consumer groups and manage their offsets.
  help        Help about any command
  iotune      Measure filesystem performance and create IO configuration file.
  plugin      List, download, update, and remove rpk plugins.
  redpanda    Interact with a local Redpanda process
  topic       Create, delete, produce to and consume from Redpanda topics.
  version     Check the current version.
  wasm        Deploy and remove inline WASM engine scripts.

Flags:
  -h, --help      help for rpk
  -v, --verbose   Enable verbose logging (default: false).

Use "rpk [command] --help" for more information about a command. """


def extract_flags(process_line):
    if process_line.find('Use "rpk') != -1:
        flag_line = process_line[process_line.find("Flags:") : process_line.find('Use "rpk')]
    else:
        flag_line = process_line[process_line.find("Flags:") :]
    flag_line = flag_line.replace("\"/var/lib/redpanda/.config/rpk/rpk.yaml\"","`/var/lib/redpanda/.config/rpk/rpk.yaml`")
    flag_line = flag_line.replace("$PWD/redpanda.yaml","`$PWD/redpanda.yaml`")
    flag_line = flag_line.replace("/etc/redpanda/redpanda.yaml","`/etc/redpanda/redpanda.yaml`")
    return flag_line


# Extract new commands (multilevel) or flags from the available ones. Example:
"""   deploy      Deploy inline WASM function.
  generate    Create an npm template project for inline WASM engine.
  remove      Remove inline WASM function. """
# or
"""       --brokers strings         Comma-separated list of broker ip:port pairs (e.g. --brokers '192.168.78.34:9092,192.168.78.35:9092,192.179.23.54:9092' ). Alternatively, you may set the REDPANDA_BROKERS environment variable with the comma-separated list of broker addresses.
      --config string           Redpanda config file, if not set the file will be searched for in the default locations
  -h, --help                    help for wasm
      --password string         SASL password to be used for authentication.
      --sasl-mechanism string   The authentication mechanism to use. Supported values: SCRAM-SHA-256, SCRAM-SHA-512.
      --tls-cert string         The certificate to be used for TLS authentication with the broker.
      --tls-enabled             Enable TLS for the Kafka API (not necessary if specifying custom certs).
      --tls-key string          The certificate key to be used for TLS authentication with the broker.
      --tls-truststore string   The truststore to be used for TLS communication with the broker.
      --user string             SASL user to be used for authentication. """


def extract_new_commands(available, is_flag):
    iterable_commands = []
    mline = ""

    for line in available.splitlines():
        if not line:
            if mline:
                mline = mline.strip() 
                iterable_commands.append(mline)
                mline = ""
            continue
        if not is_flag:
            if mline: 
                mline = mline.strip()
                iterable_commands.append(mline)
                mline = ""
            iterable_commands.append(line.split(" ")[2])
        else:
            if line.strip().startswith("-"):
                if mline:
                    mline = mline.strip() 
                    iterable_commands.append(mline)
                    mline = ""    
                mline = line[line.find("-") :].strip()
                continue
            elif line[0] != " ":
                if mline: 
                    mline = mline.strip() 
                    iterable_commands.append(mline)
                    mline = ""
                continue 
            else:
                mline += " " + line.strip()
                continue
    
    if mline: 
        mline = mline.strip() 
        iterable_commands.append(mline.strip())

    return iterable_commands


# Extract flag value, explanation and type from a flag line. Example:
"""--user string             SASL user to be used for authentication. """


def extract_all_flag(line):
    flag_set = []
    for flag in line:
        value = flag[: flag.find(" ")]
        explanation = flag[flag.find(" ") :]
        if value.find(",") != -1:
            explanation = explanation.lstrip(" ")
            value = value + " " + (explanation[: explanation.find(" ")])
            explanation = explanation[explanation.find(" ") :]

        if re.search(r"\bstring\b", explanation):
            type = "string"
            explanation = re.sub(r"\bstring\b", "", explanation)
        elif re.search(r"\bstrings\b", flag):
            type = "strings"
            explanation = re.sub(r"\bstrings\b", "", explanation)
        elif re.search(r"\bstringArray\b", flag):
            type = "stringArray"
            explanation = re.sub(r"\bstringArray\b", "", explanation)
        elif re.search(r"\bint\b", flag):
            type = "int"
            explanation = re.sub(r"\bint\b", "", explanation)
        elif re.search(r"\bint16\b", flag):
            type = "int16"
            explanation = re.sub(r"\bint16\b", "", explanation)
        elif re.search(r"\bint32\b", flag):
            type = "int32"
            explanation = re.sub(r"\bint32\b", "", explanation)
        elif re.search(r"\bint32Slice\b", flag):
            type = "int32"
            explanation = re.sub(r"\bint32Array\b", "", explanation)
        elif re.search(r"\bduration\b", flag):
            type = "duration"
            explanation = re.sub(r"\bduration\b", "", explanation)
        else:
            type = "-"
        explanation = assert_period(explanation.strip())
        flag_set.append(Flag(value, type, explanation))
    return flag_set

# Build dictionary of commands
def build_dict(cmd_dict, executed_command, explanation, usage, it_flags, flag_list):

    cmd = {"description" : explanation, "usage" : usage, "flags" : {} }

    if it_flags:
        for flag in flag_list:
            cmd['flags'][flag.value] = { "type" : flag.flag_type.strip(), "description" : flag.explanation}

    cmd_dict[executed_command] = cmd
    return cmd_dict


def build_ascii(ascii_result, executed_command, explanation, usage, it_flags, flag_list, separate_files):
    # Determine the version passed as argument or default to "latest"
    tag_modified = sys.argv[1] if len(sys.argv) > 1 else "latest"
    # Build the output directory as "autogenerated/<tag_modified>/rpk"
    rpk_gen_dir = os.path.join("autogenerated", tag_modified, "rpk")
    if not os.path.exists(rpk_gen_dir):
        os.makedirs(rpk_gen_dir)

    # Construct the asciidoc content
    ascii_result += "= " + executed_command
    ascii_result += "\n:description: " + executed_command
    ascii_result += "\n\n" + explanation

    usage_val_start = usage.find("Usage:") + len("Usage:")
    aliases_start = usage.find("Aliases:")
    aliases_val_start = usage.find("Aliases:") + len("Aliases:")

    usage_val = usage[usage_val_start:aliases_start] if aliases_start >= 0 else usage[usage_val_start:]
    ascii_result += "\n\n== Usage"
    ascii_result += "\n\n[,bash]\n"
    ascii_result += "----\n"
    ascii_result += usage_val.strip()
    ascii_result += "\n----"

    if aliases_start >= 0:
        ascii_result += "\n\n== Aliases"
        ascii_result += "\n\n[,bash]\n"
        ascii_result += "----\n"
        ascii_result += usage[aliases_val_start:].strip()
        ascii_result += "\n----"

    if it_flags:
        ascii_result += "\n\n== Flags"
        ascii_result += "\n\n[cols=\"1m,1a,2a\"]"
        ascii_result += "\n|==="
        ascii_result += "\n|*Value* |*Type* |*Description*"

    for flag in flag_list:
        ascii_result += "\n\n"
        ascii_result += "|" + flag.value + " |"
        ascii_result += flag.flag_type + " |"
        ascii_result += flag.explanation

    ascii_result += "\n|==="

    # Build filename using os.path.join rather than string concatenation.
    filename = os.path.join(rpk_gen_dir, executed_command.replace(" ", "-") + ".adoc")

    # If the file exists, delete it.
    if os.path.exists(filename):
        os.remove(filename)

    # Write the ASCII content to the file with the necessary escaping.
    with open(filename, "w", encoding="utf-8") as filetowrite:
        ascii_result = escape_chars(ascii_result)
        filetowrite.write(ascii_result)

    return ascii_result

## run basic command first
first_command = basic_commands_docker + rpk_basic_command + ["version"]
result = subprocess.run(first_command, stdout=subprocess.PIPE)
rpk_version = result.stdout.decode('utf-8').strip(" \n")

result = execute_process([])

explanation = get_explanation(result)

usage = get_usage(result)

full_command = get_commands(result)

commands = full_command[: full_command.find("Flags:")]

available_commmands = commands.lstrip("Available Commands:")
it_commands = extract_new_commands(available_commmands, False)

flags = extract_flags(result)
available_flags = flags.lstrip("Flags:")

it_flags = extract_new_commands(available_flags, True)
flag_list = extract_all_flag(it_flags)

md_result = """---
title: rpk commands
rpk_version: """ + rpk_version + """
---

`rpk` is Redpanda's command line interface (CLI) utility. rpk commands allow you to configure and manage Redpanda clusters, tune them for better performance, manage topics and groups, manage access control lists (ACLs).

This section lists each rpk command in alphabetical order, along with a table of flags for that command. All descriptions are from the output of the `rpk <command> -–help` command.

"""

executed_command = "rpk"
quantity =0

for command in it_commands:
    quantity+=1
    
    result = execute_process([command])
    executed_command = "rpk " + command

    explanation = get_explanation(result)

    usage = get_usage(result)

    full_command = get_commands(result)

    commands = full_command[: full_command.find("Flags:")]

    available_commmands = commands.lstrip("Available Commands:")
    new_commands = extract_new_commands(available_commmands, False)

    flags = extract_flags(result)
    available_flags = flags.lstrip("Flags:")

    it_flags = extract_new_commands(available_flags, True)

    flag_list = extract_all_flag(it_flags)

    cmd_dict = build_dict(cmd_dict, executed_command, explanation, usage, it_flags, flag_list);

    md_result = build_ascii(
        "", executed_command, explanation, usage, it_flags, flag_list, True
    )
 
    index = it_commands.index(command) + 1
    for new_command in new_commands:
        it_commands.insert(index, command + " " + new_command)
        index += 1

    if(quantity%20==0):
        print(f"{quantity}/{len(it_commands)} files written in disk.")

cmd_dict['rpk_version'] = rpk_version
json_object = json.dumps(cmd_dict, indent = 4) 

md_result = md_result.replace(
    """  rpk-<name>
  rpk.ac-<name>""",
    """```bash
rpk-<name>
rpk.ac-<name>
```
""",
)



md_result = md_result + suggestedReadings

# Get the version from command-line arguments, defaulting to "latest" if not provided.
tag_modified = sys.argv[1] if len(sys.argv) > 1 else "latest"

# Build a common base directory using the version.
base_dir = os.path.join("autogenerated", tag_modified, "rpk")

# Write the JSON file into a JSON subdirectory within the same base directory.
json_path = os.path.join(base_dir, "json")
if not os.path.exists(json_path):
    os.makedirs(json_path)

json_file = os.path.join(json_path, "rpk-commands.json")
try:
    with open(json_file, "w") as filetowrite:
        filetowrite.write(json_object)
    print("The rpk commands have been successfully generated at", json_file)
except Exception as e:
    print("Error generating the rpk commands file " + str(e))

# Define the directories for comparison.
dir1 = os.path.join("docs", "reference", "rpk")
dir2 = base_dir  # Using the common base directory
