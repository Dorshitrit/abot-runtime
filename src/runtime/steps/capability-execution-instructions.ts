export const CAPABILITY_PROGRAM_PREPARATION_INSTRUCTION =
  "Before selecting a command-execution capability, decide whether the work requires a long program or a program with several analysis stages. For such a program, first select an offered file-writing capability and save the complete script at a new task-specific path under your working root, respecting the current working-directory binding. Select execution of that script only after successful tool evidence confirms that it was written at the intended path; use a short invocation of the confirmed script path. Do not delegate a long inline program to the controls phase: that phase cannot replace the selected capability or insert a prerequisite file-writing step. Direct command execution remains suitable for complete self-contained commands. Never cut a program or drop required work to fit a command limit. Preserve source evidence and unrelated files. Support scripts are working material, not completed deliverables.";

export const CAPABILITY_COMMAND_CONTROLS_INSTRUCTION =
  "When materializing command-execution controls, return a syntactically complete command that performs the entire accepted operation within the declared command-length limit. Include all required statements and closing quotes, delimiters and here-document terminators. Never cut code, omit required logic, or return a partial program to fit the limit. When the accepted operation runs a saved script, use its confirmed path and a short invocation. Preserve the selected capability and operation objective; tool selection and prerequisite file creation remain the responsibility of the preceding decision step.";

export const CAPABILITY_ANALYSIS_RESULT_INSTRUCTION =
  "For parsing or analysis, verify parsing and actual coverage from the supplied results, distinguish a failed extraction from no matches, and state unresolved gaps before claiming completion. Keep conclusions within the assigned scope and the evidence actually established.";

export const CAPABILITY_ANALYSIS_CONTROLS_INSTRUCTION =
  "When the accepted operation parses or analyzes source data, ensure its result reports parsed-record counts, coverage and unresolved parsing exceptions. Distinguish a failed extraction from zero matches, agreement or successful verification. Preserve the accepted operation and its required scope.";

export const CAPABILITY_PROGRAM_PLANNING_INSTRUCTION =
  "When the proposed work requires a long program, plan a separate file-writing step for the complete script at a new task-specific path under the working root. Keep source evidence and unrelated files unchanged. Execution must follow successful script creation and use a short command referring to the saved path; do not plan to embed a long program in the command field.";
