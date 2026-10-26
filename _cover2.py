from PIL import Image
import os
SRC = r"E:/DSH/.dsh/attachments/v1/objects/41/41734b852ca894d5e2c21598c28a9363d61d59d7601a46e4d2d4ea109044c47a"
D = r"E:/DSH/projects/dsh-plugin-control-your-capture/assets/"
im = Image.open(SRC).convert("RGB")
w = 1600; h = round(im.height * w / im.width)
im2 = im.resize((w, h), Image.LANCZOS)
for q in (88, 82, 76):
    p = D + ("cover-q%d.webp" % q)
    im2.save(p, "WEBP", quality=q, method=6)
    print(q, os.path.getsize(p) // 1024, "KB", im2.size)
