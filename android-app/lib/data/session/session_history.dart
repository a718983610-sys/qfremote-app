/// Keep recent diagnostics bounded without retaining an entire long session.
void appendSessionHistory<T>(List<T> history, T value, {int limit = 256}) {
  history.add(value);
  if (history.length > limit) history.removeRange(0, history.length - limit);
}
