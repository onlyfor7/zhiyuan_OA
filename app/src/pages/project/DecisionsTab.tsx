import { DecisionCenter } from "../../components/DecisionCenter";
import { useSpaceParams } from "./space-context";

/** 项目空间·决策页签 */
export default function DecisionsTab() {
  const { projectId } = useSpaceParams();
  return <DecisionCenter projectId={projectId} />;
}
