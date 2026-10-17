// The real CLI with the test ops folder in place of x/ops. It is never a build's worktree, even
// when the checks run inside one.
import { main } from "../../../core/cli";
import { xDomain } from "../../../x/domain";

await main(xDomain({ dir: import.meta.dir, worktree: false }));
