import pandas as pd

df = pd.read_csv("evaluation.csv")

def generate_prediction(text):
    replacements = {
        "Mahasiswa": "Mahasiswa dapat",
        "Durasi layanan": "Proses layanan",
        "Pengajuan dilakukan": "Proses pengajuan dilakukan",
        "Pengajuan": "Proses pengajuan",
        "mengisi form": "mengisi formulir",
        "mengisi formulir": "melengkapi formulir",
        "menunggu verifikasi": "menunggu proses verifikasi",
        "hari kerja": "hari kerja sesuai ketentuan"
    }

    pred = text

    for old, new in replacements.items():
        pred = pred.replace(old, new)

    return pred

df["prediction"] = df["reference"].apply(generate_prediction)

df.to_csv("evaluation_with_prediction.csv", index=False)

print("File berhasil dibuat: evaluation_with_prediction.csv")