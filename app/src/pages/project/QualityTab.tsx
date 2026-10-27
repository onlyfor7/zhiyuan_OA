import { QualityCenter } from "../../components/QualityCenter";
import { useSpaceParams } from "./space-context";

/** 项目空间·质量页签 */
export default function QualityTab() {
  const { projectId } = useSpaceParams();
  return <QualityCenter projectId={projectId} />;
}
