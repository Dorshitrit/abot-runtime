/** Explains a HOME publication rejection without changing the stored screen or starting another run. */
export function sparkHomeRunFailureMessage(run) {
  if (run?.status !== "failed") return "";
  if (run.errorCode !== "spark_home_dashboard_widgets_required") return "";
  return "The generated screen included fewer than three Dashboard widgets, so it was not saved. Your HOME is unchanged.";
}
