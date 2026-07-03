// Headless Alloy runner: parses a .als module, executes every run/check
// command with the bundled SAT4J solver, and prints SAT/UNSAT + a compact
// readout of each satisfying instance (nodes, ids, child edges).
//
// Compile & run (jar from Maven Central: org.alloytools.alloy.dist):
//   javac -cp alloy.jar RunAlloy.java
//   java  -cp alloy.jar:. RunAlloy MindMap.als
//
// Uses only the public Alloy API, so it works from the dist jar with no GUI.

import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.Module;
import edu.mit.csail.sdg.ast.Sig;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.A4Tuple;
import edu.mit.csail.sdg.translator.A4TupleSet;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;

public class RunAlloy {
  public static void main(String[] args) throws Exception {
    String file = args.length > 0 ? args[0] : "MindMap.als";
    A4Reporter rep = new A4Reporter();
    Module world = CompUtil.parseEverything_fromFile(rep, null, file);
    A4Options opts = new A4Options();
    opts.solver = kodkod.engine.satlab.SATFactory.DEFAULT;  // bundled SAT4J

    System.out.println("Alloy module: " + file);
    System.out.println("commands: " + world.getAllCommands().size());
    System.out.println("======================================================================");

    for (Command cmd : world.getAllCommands()) {
      A4Solution sol =
          TranslateAlloyToKodkod.execute_command(rep, world.getAllReachableSigs(), cmd, opts);
      String kind = cmd.check ? "check" : "run";
      boolean sat = sol.satisfiable();
      // For `run`, SAT = "instance found"; for `check`, SAT = "counterexample".
      System.out.printf("%-28s [%s]  ->  %s%n",
          cmd.label, kind, sat ? "SATISFIABLE (instance found)" : "UNSAT (none)");
      if (sat) {
        printInstance(sol, world);
      }
      System.out.println("----------------------------------------------------------------------");
    }
  }

  static void printInstance(A4Solution sol, Module world) {
    for (Sig s : world.getAllReachableSigs()) {
      String sn = s.label.replace("this/", "");
      if (!sn.equals("Node")) continue;
      A4TupleSet nodes = sol.eval(s);
      System.out.println("    nodes: " + nodes.size());
      // per-field dump
      for (Sig.Field f : s.getFields()) {
        A4TupleSet ts = sol.eval(f);
        StringBuilder sb = new StringBuilder();
        for (A4Tuple t : ts) {
          if (sb.length() > 0) sb.append(", ");
          sb.append(t.atom(0)).append("->").append(t.atom(1));
        }
        System.out.println("    " + f.label + ": {" + sb + "}");
      }
    }
  }
}
