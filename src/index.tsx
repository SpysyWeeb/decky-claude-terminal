import { ButtonItem, Navigation, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { definePlugin, routerHook } from "@decky/api";
import { FaTerminal } from "react-icons/fa";
import { ClaudeTerminal } from "./Terminal";

const ROUTE = "/claude-terminal";

function QuickAccessPanel() {
  return (
    <PanelSection>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => {
            Navigation.CloseSideMenus();
            Navigation.Navigate(ROUTE);
          }}
        >
          Open fullscreen
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ClaudeTerminal fontSize={10} compact />
      </PanelSectionRow>
    </PanelSection>
  );
}

function FullscreenPage() {
  return (
    <div
      style={{
        height: "100vh",
        padding: "48px 16px 56px",
        background: "#0e141b",
        boxSizing: "border-box",
      }}
    >
      <ClaudeTerminal fontSize={15} />
    </div>
  );
}

export default definePlugin(() => {
  routerHook.addRoute(ROUTE, FullscreenPage, { exact: true });

  return {
    name: "Claude Terminal",
    titleView: <div className={staticClasses.Title}>Claude Code</div>,
    content: <QuickAccessPanel />,
    icon: <FaTerminal />,
    onDismount() {
      routerHook.removeRoute(ROUTE);
    },
  };
});
