export const CAPABILITY_COMMAND_CONTROLS_INSTRUCTION =
  "When materializing command-execution controls, return a syntactically complete command that performs the entire accepted operation within the declared command-length limit. Include all required statements and closing quotes, delimiters and here-document terminators. Never cut code, omit required logic, or return a partial program to fit the limit. When the accepted operation runs a saved script, use its confirmed path and a short invocation. Preserve the selected capability and operation objective; tool selection and prerequisite file creation remain the responsibility of the preceding decision step.";

export const CAPABILITY_ANALYSIS_RESULT_INSTRUCTION =
  "For parsing or analysis, verify parsing and actual coverage from the supplied results, distinguish a failed extraction from no matches, and state unresolved gaps before claiming completion. Keep conclusions within the assigned scope and the evidence actually established.";

export const CAPABILITY_ANALYSIS_CONTROLS_INSTRUCTION =
  "When the accepted operation parses or analyzes source data, ensure its result reports parsed-record counts, coverage and unresolved parsing exceptions. Distinguish a failed extraction from zero matches, agreement or successful verification. Preserve the accepted operation and its required scope.";
