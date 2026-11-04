import { useState } from "react";

import { FormDialog } from "./FormDialog";

/** 9a §5：创建类操作走弹窗（F2/F3 范式）；页级路由保留深链。内嵌既有 NewPage 表单组件。 */
export function CreateInDialog({
  label,
  title,
  eyebrow,
  form: Form,
}: {
  label: string;
  title: string;
  eyebrow: string;
  form: React.ComponentType;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="primary-action" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <FormDialog title={title} eyebrow={eyebrow} onClose={() => setOpen(false)} wide>
          <div className="p9a-embed">
            <Form />
          </div>
        </FormDialog>
      ) : null}
    </>
  );
}
