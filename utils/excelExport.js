const ExcelJS = require('exceljs');

async function exportToExcel({ data, columns, filename }, res) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');

  // Add columns
  worksheet.columns = [...columns];

  // Bold header
  worksheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true };
  });

  // Add rows with serial numbers
  data.forEach((row, index) => {
    worksheet.addRow({ s_no: index + 1, ...row });
  });

  // Generate binary buffer
  const buffer = await workbook.xlsx.writeBuffer();

  // Set headers for binary
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);
  res.setHeader('Content-Length', buffer.length);

  // Send binary
  res.end(buffer);
}

module.exports = { exportToExcel };
