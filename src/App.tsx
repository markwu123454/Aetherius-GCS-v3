import TopBar from "./components/TopBar";
import Workspace from "./components/Workspace";
import {useWorkspace} from "./workspace/useWorkspace";
import "./App.css";

function App() {
    // Owned here so the top bar's panel launcher and the workspace itself act
    // on the same state.
    const workspace = useWorkspace();

    return (
        <main className="flex h-screen w-screen flex-col overflow-hidden">
            <TopBar openIds={workspace.openIds} actions={workspace.actions}/>
            <div className="min-h-0 flex-1">
                <Workspace workspace={workspace}/>
            </div>
        </main>
    );
}

export default App;
