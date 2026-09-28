/** Bounded UIA view rooted in the focused document; unrelated document trees are excluded. */
export const WINDOWS_ACCESSIBILITY_SCRIPT = String.raw`
public static partial class AbotComputer {
  static AutomationElement FocusedDocument(AutomationElement root) {
    try {
      var item=AutomationElement.FocusedElement;
      AutomationElement document=null;
      for(int depth=0;depth<64 && item!=null;depth++) {
        if(item.Equals(root)) return document;
        if(item.Current.ControlType==ControlType.Document) document=item;
        item=TreeWalker.ControlViewWalker.GetParent(item);
      }
    } catch {}
    return null;
  }
  static bool HasVisibleIntersection(System.Windows.Rect bounds,Rect region) {
    if(bounds.IsEmpty || bounds.Width<1 || bounds.Height<1) return false;
    if(Double.IsInfinity(bounds.X) || Double.IsInfinity(bounds.Y)) return false;
    if(bounds.Right<=region.Left || bounds.Bottom<=region.Top) return false;
    return bounds.Left<region.Right && bounds.Top<region.Bottom;
  }
  static string BoundedText(string text,int maximum) {
    if(text==null) return "";
    return text.Length<=maximum?text:text.Substring(0,maximum);
  }
  static Dictionary<string,object> AccessibilityNode(AutomationElement element,bool leaf,Rect region) {
    var current=element.Current;
    if(current.IsOffscreen || current.IsPassword) return null;
    var bounds=current.BoundingRectangle;
    if(!HasVisibleIntersection(bounds,region)) return null;
    var node=Obj("role",current.ControlType.ProgrammaticName.Replace("ControlType.",""),
      "name",BoundedText(current.Name,512),"focused",current.HasKeyboardFocus,
      "bounds",Rectangle((int)Math.Round(bounds.X),(int)Math.Round(bounds.Y),
        Math.Max(1,(int)Math.Round(bounds.Width)),Math.Max(1,(int)Math.Round(bounds.Height))));
    // Parent text/value patterns can include invisible or protected descendants.
    if(!leaf) return node;
    object pattern;
    if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
      node["value"]=BoundedText(((ValuePattern)pattern).Current.Value,2048);
      return node;
    }
    if(!element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return node;
    var parts=new List<string>(); int remaining=2048;
    foreach(var range in ((TextPattern)pattern).GetVisibleRanges()) {
      if(remaining<=0) break;
      string text=range.GetText(remaining);
      parts.Add(text); remaining-=text.Length;
    }
    node["value"]=BoundedText(String.Join("\n",parts.ToArray()),2048);
    return node;
  }
  static List<object> ReadAccessibility(Rect region,out bool truncated) {
    var nodes=new List<object>(); truncated=true;
    try {
      IntPtr foreground=GetForegroundWindow();
      if(foreground==IntPtr.Zero) return nodes;
      var root=AutomationElement.FromHandle(foreground);
      var document=FocusedDocument(root);
      var queue=new Queue<AutomationElement>(); queue.Enqueue(document ?? root);
      var walker=TreeWalker.ControlViewWalker;
      var watch=Stopwatch.StartNew(); int visited=0,bytes=0;
      while(queue.Count>0 && nodes.Count<128 && visited<600 && watch.ElapsedMilliseconds<500) {
        var element=queue.Dequeue(); visited++;
        try {
          if(element.Current.IsPassword || element.Current.IsOffscreen) continue;
          if(document==null && element.Current.ControlType==ControlType.Document) continue;
          var child=walker.GetFirstChild(element);
          var node=AccessibilityNode(element,child==null,region);
          if(node!=null) {
            int nodeBytes=Encoding.UTF8.GetByteCount(Json.Serialize(node));
            if(bytes+nodeBytes>32768) return nodes;
            nodes.Add(node); bytes+=nodeBytes;
          }
          int siblings=0;
          while(child!=null && siblings<600 && queue.Count<600 && watch.ElapsedMilliseconds<500) {
            queue.Enqueue(child); siblings++; child=walker.GetNextSibling(child);
          }
        } catch(ElementNotAvailableException) {}
        catch(InvalidOperationException) {}
      }
      // Visible UIA is a subset of pixels even when its bounded traversal exhausted the queue.
      truncated=true;
    } catch {}
    return nodes;
  }
}
`;
